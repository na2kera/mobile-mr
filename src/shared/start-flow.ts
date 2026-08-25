// 開始フロー（センサー許可 → カメラ → 全画面化の直列化）。01〜05 で毎回複製していた
// ものを Phase 6 で抽出した。順序の根拠は PAIN_POINTS の
// 「全画面遷移中はセンサー許可ダイアログが出ない（1タップに同居できない）」
// 「開始ジェスチャーの奪い合いにカメラ許可が3人目として参加」を参照。要点:
//   - iOS はセンサー許可がユーザージェスチャー起点でないと出ない
//   - 全画面遷移中は許可ダイアログが出ないので、ダイアログ系（センサー → カメラ）を先に直列で
//     済ませ、最後に全画面化を試みる。初回は activation が切れて全画面化が拒否されるので
//     「タップで全画面表示」ボタン（2 タップ目）に落とす
// 02〜05 は過去のデモとして手を付けず、06 以降がこれを使う

/** タッチ端末（= スマホ実機）か。PC（マウス）では OrbitControls に切り替える判定に使う */
export function isTouchDevice(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}

/** "ok" / "unsupported" / エラー文字列 */
export type FullscreenStatus = string;

export function enterFullscreen(onStatus: (status: FullscreenStatus) => void) {
  const el = document.documentElement;
  if (!el.requestFullscreen) {
    onStatus("unsupported");
    return;
  }
  el.requestFullscreen().then(
    () => onStatus("ok"),
    (e) => onStatus(e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
  );
}

export type FullscreenControllerOptions = {
  /** 「タップで全画面表示」ボタン（失敗時・解除後の再入導線） */
  button: HTMLButtonElement;
  touch: boolean;
  /** requestFullscreen の結果（HUD 表示用） */
  onResult: (status: FullscreenStatus) => void;
  /** fullscreenchange（"enter" / "exit"。HUD 表示用） */
  onChange: (change: "enter" | "exit") => void;
  /** 開始済みか（解除後にボタンを出すのは開始後だけ） */
  isStarted: () => boolean;
};

/**
 * 全画面化の試行と再入ボタンの表示制御をまとめる。戻り値の関数を「全画面化を試みる」
 * タイミング（開始フロー末尾・ボタンのタップ）で呼ぶ
 */
export function setupFullscreen(opts: FullscreenControllerOptions): () => void {
  const tryEnter = () => {
    opts.button.hidden = true;
    enterFullscreen((status) => {
      opts.onResult(status);
      if (status !== "ok" && status !== "unsupported") opts.button.hidden = false;
    });
  };
  opts.button.addEventListener("click", tryEnter);
  document.addEventListener("fullscreenchange", () => {
    const inFullscreen = Boolean(document.fullscreenElement);
    opts.onChange(inFullscreen ? "enter" : "exit");
    if (opts.touch && opts.isStarted()) opts.button.hidden = inFullscreen;
  });
  return tryEnter;
}

export type StartFlowHooks = {
  /** センサー許可の結果（"granted" / "denied" / エラー文字列）。許可要求が不要な環境では呼ばれない */
  onSensor: (state: string) => void;
  /** 頭追従を開始する（許可が取れた or 許可不要のときだけ呼ばれる） */
  startControls: () => void;
  /**
   * 許可フローが決着した（許可 / 拒否 / 不要のいずれか）。「許可ダイアログ中で controls が
   * まだ無い」状態と「拒否されて頭追従が無い」状態を区別したいときに使う（05 の sensorSettled）
   */
  onSensorSettled?: () => void;
  /** カメラを開始する。成否の HUD 表示は呼び出し側で行い、reject させないこと */
  startCamera: () => Promise<void>;
  /** 全画面化を試みる（タッチ端末で頭追従が使えるときだけ、カメラの後に呼ばれる） */
  tryEnterFullscreen: () => void;
};

/**
 * 開始ボタンのクリックハンドラ内から呼ぶ（ユーザージェスチャー内であることが必須）。
 * 通信の開始などジェスチャーに依存しない処理は、これとは別に呼び出し側で始めてよい
 */
export function runStartFlow(touch: boolean, hooks: StartFlowHooks) {
  const settled = () => hooks.onSensorSettled?.();
  if (!touch) {
    hooks.startControls();
    settled();
    void hooks.startCamera();
    return;
  }
  const doe = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<"granted" | "denied">;
  };
  if (!doe.requestPermission) {
    // Android 等、許可要求が不要な環境
    hooks.startControls();
    settled();
    hooks.startCamera().then(hooks.tryEnterFullscreen);
    return;
  }
  doe
    .requestPermission()
    .then(async (state) => {
      hooks.onSensor(state);
      if (state === "granted") hooks.startControls();
      settled(); // 拒否でも確定（頭追従なしで続ける）
      await hooks.startCamera();
      if (state === "granted") hooks.tryEnterFullscreen();
    })
    .catch(async (e: unknown) => {
      hooks.onSensor(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      settled();
      await hooks.startCamera();
    });
}
