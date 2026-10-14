/**
 * マップ生成の内部ヘルパー: ハッシュベースの決定論的バリューノイズ。
 *
 * ここに置く関数はすべて「渡された引数だけ」から O(1) で値を導く純関数にする。
 * 「前の行・前のチャンクの計算結果に依存する」再帰的な実装は避ける
 * （そうすれば、全体再計算もキャッシュも不要なまま決定論と生成順非依存の
 * 両方が自然に満たせる。river.ts の riverAt がこの方式に依存している）。
 */

import { createRng, next, type Rng } from '../rng';

/** [0, 1) の滑らかな補間カーブ（proto/shared/terrain.ts の smooth と同じ考え方） */
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** ハッシュ値1個から [0, 1) の格子点値を作る（同じ hash なら常に同じ値） */
export function latticeValue(hash: number): number {
  const rng = createRng(hash);
  return next(rng);
}

/**
 * チャンク内で完結する2Dバリューノイズ用の粗格子（(res+1)×(res+1)）を作る。
 * rng を消費するので、呼び出し側で消費順を固定すること（決定論を保つため）。
 */
export function noiseGrid(rng: Rng, res: number): number[][] {
  const size = res + 1;
  return Array.from({ length: size }, () => Array.from({ length: size }, () => next(rng)));
}

/** 粗格子をバイリニア補間して [0, 1) を返す（u, v は 0..1 に正規化した位置） */
export function sampleGrid(grid: number[][], res: number, u: number, v: number): number {
  const fx = u * res;
  const fy = v * res;
  const x0 = Math.min(res, Math.floor(fx));
  const y0 = Math.min(res, Math.floor(fy));
  const x1 = Math.min(res, x0 + 1);
  const y1 = Math.min(res, y0 + 1);
  const tx = smoothstep(fx - x0);
  const ty = smoothstep(fy - y0);
  const a = grid[y0]?.[x0] ?? 0;
  const b = grid[y0]?.[x1] ?? 0;
  const c = grid[y1]?.[x0] ?? 0;
  const d = grid[y1]?.[x1] ?? 0;
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}
