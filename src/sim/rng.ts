/**
 * 決定論的なシード付き乱数（mulberry32）。
 * sim では Math.random を使わず、必ずこれを通す（実装書 §0）。
 * 状態は単一の number なので GameState.rngState としてそのまま直列化できる。
 */

/** 32bit 文字列ハッシュ。シード導出に使う（実装書 §5: hash(seed, cx, cy)） */
export function hashInts(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    let x = v | 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff;
      h = Math.imul(h, 0x01000193);
      x >>>= 8;
    }
  }
  return h >>> 0;
}

export interface Rng {
  /** 現在の内部状態。GameState.rngState へ保存する */
  state: number;
}

export function createRng(seed: number): Rng {
  return { state: seed >>> 0 };
}

/** [0, 1) の乱数を返し、rng の状態を進める */
export function next(rng: Rng): number {
  rng.state = (rng.state + 0x6d2b79f5) >>> 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** [min, max) の整数 */
export function nextInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(next(rng) * (max - min));
}

/** 確率 p で true */
export function chance(rng: Rng, p: number): boolean {
  return next(rng) < p;
}

/** 重み付き抽選。weights の合計が 0 なら -1 を返す */
export function weightedPick(rng: Rng, weights: number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return -1;
  let r = next(rng) * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i] ?? 0;
    if (r < 0) return i;
  }
  return weights.length - 1;
}
