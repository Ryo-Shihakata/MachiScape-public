/**
 * 大域的な川判定（実装書 §5）。
 *
 * チャンクごとに独立した乱数（hashInts(seed, cx, cy)）で地形を作ると、
 * 隣接チャンクの川は繋がらない。そこでグローバルタイル座標だけから
 * O(1) で判定できる純関数として実装する。
 *
 * 手法: 川の中心線を「行 y ごとの制御値」の1次元バリューノイズとして表す。
 * 制御点は hashInts(seed, riverIndex, controlIndex, ...) というハッシュから
 * 直接導く格子点値で、行間は smoothstep 補間する。つまり中心線の位置は
 * 「y だけの関数」であり、前の行を計算しないと次の行が分からない、という
 * 再帰的な依存がない。これにより：
 * - 呼び出しごとのコストはハッシュ数回分で、全体再計算にならない
 * - 「module スコープの Map キャッシュ」で行の履歴を持つ必要がない
 *   （キャッシュしたくなる典型的な理由＝再帰計算がそもそも存在しない）
 *
 * 連結の担保: 行 y の水タイルを「行 y の中心点」と「行 y+1 の中心点」を
 * つなぐ水平区間 [min(p(y), p(y+1)), max(p(y), p(y+1))] と定義する
 * （proto/shared/terrain.ts の carveRiver と同じ考え方）。
 * 行 y-1 の区間は必ず (p(y), y-1) を含み、行 y の区間は (p(y), y) を含む
 * ため、同じ x で y が連続する2タイルが必ず存在し、4近傍で連結する。
 * 行内で複数タイルにまたがる区間（p(y)≠p(y+1)のとき）自体も連続した
 * 水平区間なので4近傍で繋がっている。
 */

import { hashInts } from '../rng';
import { lerp, latticeValue, smoothstep } from './noise';

// balance.ts へ移すべき値（他担当と衝突するため balance.ts は編集せず、ここに置く）
const RIVER_ROW_SCALE = 24; // 中心線の制御点の行間隔（タイル）。大きいほど緩やかに蛇行する
const RIVER_MEANDER_RANGE = 7; // 中心線が基準位置から左右に振れる最大幅（タイル）
const RIVER_BASE_SPREAD = 20; // 川の基準x位置の探索範囲（開始チャンク付近に収まるようにする）
const RIVER_WIDTH_EXTRA_PROB = 0.5; // 川幅をもう1タイル広げる確率（幅1〜2の実現）
const RIVER_TWO_PROBABILITY = 0.3; // 2本目の川を出す確率（実装書 §5: 1〜2本）

// ハッシュの塩（同じ seed から複数の独立した乱数列を作るための識別子）
const SALT_RIVER_COUNT = 101;
const SALT_RIVER_BASE = 103;
const SALT_RIVER_CONTROL = 107;
const SALT_RIVER_WIDTH = 109;

function riverCount(seed: number): number {
  return latticeValue(hashInts(seed, SALT_RIVER_COUNT)) < RIVER_TWO_PROBABILITY ? 2 : 1;
}

function riverBaseX(seed: number, riverIndex: number): number {
  const v = latticeValue(hashInts(seed, SALT_RIVER_BASE, riverIndex));
  return Math.round((v - 0.5) * 2 * RIVER_BASE_SPREAD);
}

function riverControlValue(seed: number, riverIndex: number, controlIndex: number): number {
  return latticeValue(hashInts(seed, SALT_RIVER_CONTROL, riverIndex, controlIndex));
}

function riverCenterX(seed: number, riverIndex: number, y: number): number {
  const t = y / RIVER_ROW_SCALE;
  const i0 = Math.floor(t);
  const frac = smoothstep(t - i0);
  const v0 = riverControlValue(seed, riverIndex, i0);
  const v1 = riverControlValue(seed, riverIndex, i0 + 1);
  const v = lerp(v0, v1, frac); // [0, 1)
  return riverBaseX(seed, riverIndex) + (v - 0.5) * 2 * RIVER_MEANDER_RANGE;
}

function riverPointX(seed: number, riverIndex: number, y: number): number {
  return Math.round(riverCenterX(seed, riverIndex, y));
}

function riverWidthExtra(seed: number, riverIndex: number, y: number): boolean {
  return latticeValue(hashInts(seed, SALT_RIVER_WIDTH, riverIndex, y)) < RIVER_WIDTH_EXTRA_PROB;
}

function riverAtForIndex(seed: number, riverIndex: number, x: number, y: number): boolean {
  const p0 = riverPointX(seed, riverIndex, y);
  const p1 = riverPointX(seed, riverIndex, y + 1);
  const lo = Math.min(p0, p1);
  let hi = Math.max(p0, p1);
  if (riverWidthExtra(seed, riverIndex, y)) hi += 1;
  return x >= lo && x <= hi;
}

/**
 * グローバルタイル座標 (x, y) が川かどうか。
 * seed だけから決まり、チャンクの生成順・生成有無に依存しない。
 */
export function riverAt(seed: number, x: number, y: number): boolean {
  const count = riverCount(seed);
  for (let i = 0; i < count; i++) {
    if (riverAtForIndex(seed, i, x, y)) return true;
  }
  return false;
}
