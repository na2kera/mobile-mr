// 開始フロー（センサー許可 → カメラ → 全画面化の直列化）。01〜05 で毎回複製していた
// ものを Phase 6 で抽出した。順序の根拠は PAIN_POINTS の
// 「全画面遷移中はセンサー許可ダイアログが出ない（1タップに同居できない）」
// 「開始ジェスチャーの奪い合いにカメラ許可が3人目として参加」を参照。要点:
//   - iOS はセンサー許可がユーザージェスチャー起点でないと出ない
//   - 全画面遷移中は許可ダイアログが出ないので、ダイアログ系（センサー → カメラ）を先に直列で
//     済ませ、最後に全画面化を試みる。初回は activation が切れて全画面化が拒否されるので
//     「タップで全画面表示」ボタン（2 タップ目）に落とす
// Android Chrome（許可ダイアログが無い環境）向けの補足:
//   - センサーはダイアログ無しで動く（最近の Chrome は互換のため requestPermission を持ち、
//     ダイアログ無しで即 "granted" を返す。古い Chrome には無い）が、サイト設定の
//     「モーションセンサー」がブロックだと deviceorientation が黙って届かない。実機では console が
//     見えないので、イベントが実際に届いたかを HUD に出す（watchSensorEvents）
//   - 全画面中は screen.orientation.lock() が使える（iOS Safari は非対応）ので、全画面化に
//     成功したら横向きに固定を試みる。失敗・非対応でも従来どおり「横向きにしてください」の案内に落ちる
//   - Wake Lock で画面の消灯を防ぐ（Android Chrome / iOS 16.4+。ゴーグル装着中は触れないため）
// 02〜05 は過去のデモとして手を付けず、06 以降がこれを使う

/** タッチ端末（= スマホ実機）か。PC（マウス）では OrbitControls に切り替える判定に使う */
export function isTouchDevice(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
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
    (e) => onStatus(errorText(e)),
  );
}

/**
 * 横向きに固定する（全画面中の Android Chrome で有効）。結果は HUD 用の文字列。
 * TS の lib.dom は Safari 非対応を理由に ScreenOrientation.lock の型を持たないので自前で見る
 */
export function lockLandscape(): Promise<string> {
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (type: string) => Promise<void>;
  };
  if (typeof orientation?.lock !== "function") return Promise.resolve("lock=unsupported");
  return orientation.lock("landscape").then(
    () => "lock=ok",
    (e) => `lock=${errorText(e)}`,
  );
}

export type FullscreenControllerOptions = {
  /** 「タップで全画面表示」ボタン（失敗時・解除後の再入導線） */
  button: HTMLButtonElement;
  touch: boolean;
  /** requestFullscreen の結果（HUD 表示用。成功時はタッチ端末なら横向き固定の結果も続けて届く） */
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
      // 横向き固定は全画面中しか許可されない（Android Chrome）ので成功後に続けて試みる
      if (status === "ok" && opts.touch) {
        void lockLandscape().then((lock) => opts.onResult(`ok ${lock}`));
      }
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

/**
 * deviceorientation が実際に届いているかを見て報告する。許可が取れた（または不要な）あとに呼ぶ。
 * PC Chrome はセンサーが無いと alpha/beta/gamma が全部 null のイベントを 1 回だけ発火するので、
 * それは「届いた」に数えない
 */
export function watchSensorEvents(
  onStatus: (status: "events-ok" | "no-events") => void,
  timeoutMs = 3000,
) {
  const onEvent = (e: DeviceOrientationEvent) => {
    if (e.alpha === null && e.beta === null && e.gamma === null) return;
    clearTimeout(timer);
    removeEventListener("deviceorientation", onEvent);
    onStatus("events-ok");
  };
  const timer = setTimeout(() => {
    removeEventListener("deviceorientation", onEvent);
    onStatus("no-events");
  }, timeoutMs);
  addEventListener("deviceorientation", onEvent);
}

/**
 * 画面の消灯を防ぐ（Wake Lock API）。ユーザージェスチャーは不要だが、タブが裏に回ると解放されるので
 * 表に戻ったときに取り直す。結果は HUD 用の文字列（"ok" / "unsupported" / "released" / エラー）
 */
export function keepScreenAwake(onStatus: (status: string) => void) {
  if (!("wakeLock" in navigator)) {
    onStatus("unsupported");
    return;
  }
  const acquire = async () => {
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      onStatus("ok");
      sentinel.addEventListener("release", () => onStatus("released"));
    } catch (e: unknown) {
      onStatus(errorText(e));
    }
  };
  void acquire();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void acquire();
  });
}

export type StartFlowHooks = {
  /**
   * センサーの状態（HUD 用）。許可要求のある環境（iOS）は "granted" / "denied" / エラー文字列、
   * 無い環境（Android 等）は "no-permission-api"。頭追従を始めたあと、イベントが実際に届けば
   * "<前の状態> events-ok"、3 秒届かなければ "<前の状態> no-events" が続けて届く
   */
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
  /** Wake Lock の結果（HUD 用）。渡すとタッチ端末で画面の消灯を防ぐ */
  onWakeLock?: (status: string) => void;
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
  if (hooks.onWakeLock) keepScreenAwake(hooks.onWakeLock);
  const startControlsAndWatch = (state: string) => {
    hooks.startControls();
    watchSensorEvents((events) => hooks.onSensor(`${state} ${events}`));
  };
  const doe = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<"granted" | "denied">;
  };
  if (!doe.requestPermission) {
    // 古い Android Chrome 等、許可要求の API 自体が無い環境（最近の Chrome は API があり即 granted）
    hooks.onSensor("no-permission-api");
    startControlsAndWatch("no-permission-api");
    settled();
    hooks.startCamera().then(hooks.tryEnterFullscreen);
    return;
  }
  doe
    .requestPermission()
    .then(async (state) => {
      hooks.onSensor(state);
      if (state === "granted") startControlsAndWatch(state);
      settled(); // 拒否でも確定（頭追従なしで続ける）
      await hooks.startCamera();
      if (state === "granted") hooks.tryEnterFullscreen();
    })
    .catch(async (e: unknown) => {
      hooks.onSensor(errorText(e));
      settled();
      await hooks.startCamera();
    });
}
