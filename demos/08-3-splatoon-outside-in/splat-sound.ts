// 着弾の「ぺちゃっ」（Web Audio で合成。音声ファイル不要）。ゴーグル装着中は音の手応えが効く。
// iOS Safari は AudioContext をユーザージェスチャー内で作る/再開する必要があるので、開始ボタンで unlock() を呼ぶ。
// 音が出せない環境（ヘッドレス・許可なし）では黙って何もしない
export type SplatSound = {
  /** ユーザージェスチャー内で呼ぶ（AudioContext の作成と resume） */
  unlock(): void;
  /**
   * 1 回鳴らす。gain は 0..1。overwrote（塗り替え）は少し高めの音にする
   */
  play(gain: number, overwrote: boolean): void;
};

const MAX_PER_SEC = 12;

export function createSplatSound(enabled: boolean): SplatSound {
  let ctx: AudioContext | null = null;
  let noise: AudioBuffer | null = null;
  const recent: number[] = [];

  function ensure() {
    if (!enabled || ctx) return;
    try {
      ctx = new AudioContext();
      const sr = ctx.sampleRate;
      const len = Math.floor(sr * 0.16);
      noise = ctx.createBuffer(1, len, sr);
      const data = noise.getChannelData(0);
      for (let i = 0; i < len; i++) {
        // 減衰するホワイトノイズ（先頭を鋭く）
        const env = Math.exp(-i / (sr * 0.045));
        data[i] = (Math.random() * 2 - 1) * env;
      }
    } catch {
      ctx = null;
    }
  }

  return {
    unlock() {
      ensure();
      if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
    },
    play(gain, overwrote) {
      if (!ctx || !noise || ctx.state !== "running") return;
      const now = ctx.currentTime;
      // 連射で鳴りすぎないよう 1 秒あたりの上限
      const wall = performance.now();
      while (recent.length > 0 && wall - recent[0] > 1000) recent.shift();
      if (recent.length >= MAX_PER_SEC) return;
      recent.push(wall);
      const g = Math.min(1, Math.max(0, gain)) * 0.6;
      // ノイズ → ローパス（高→低へ掃引）→ ゲイン
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(overwrote ? 3200 : 2200, now);
      lp.frequency.exponentialRampToValueAtTime(260, now + 0.13);
      lp.Q.value = 0.8;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(g, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      src.connect(lp).connect(ng).connect(ctx.destination);
      src.start(now);
      src.stop(now + 0.17);
      // 低い「ぽん」（音程が落ちる短いサイン波）
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(overwrote ? 330 : 240, now);
      osc.frequency.exponentialRampToValueAtTime(70, now + 0.09);
      const og = ctx.createGain();
      og.gain.setValueAtTime(g * 0.45, now);
      og.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc.connect(og).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.11);
    },
  };
}
