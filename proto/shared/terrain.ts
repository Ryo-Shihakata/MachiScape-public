/**
 * P0 共通の地形（計画書 §7 / 実装書 §19 P0）。
 *
 * 3方式が別々に地形を生成すると、Ryo が比較するのは「空間モデル」ではなく
 * 「たまたま生成された地形」になってしまう。ダミー交通と同じ理由で地形も共通化し、
 * 3方式がまったく同じ地形の上で比べられるようにする。
 *
 * ヘックス方式は正方タイルではないので、`terrainAtWorld` でワールド座標から
 * サンプリングして使う（同じ地形が同じ見た目の位置に出る）。
 *
 * 本番のマップ生成（実装書 §5）とは別物。チャンク・森・拡張は扱わない。
 */

import { createRng, next, type Rng } from '../../src/sim/rng';

export type ProtoTerrain = 'plain' | 'water' | 'mountain';

export const PROTO_MAP_SIZE = 48;
export const PROTO_MAP_SEED = 20260729;

/**
 * 山にする面積の割合。固定しきい値にするとシード次第で 12%〜38% とばらつき、
 * 「ほぼ建設できないマップ」が出てしまう。上位何％を山にするかで決めることで、
 * どのシードでも建設可能な面積を保証する。
 */
const MOUNTAIN_RATIO = 0.16;
/** 値ノイズの粗グリッド解像度。小さいほど山塊が大きくなる */
const NOISE_RES = 6;

/** [y][x] で引く地形グリッド */
export type TerrainField = ProtoTerrain[][];

export function generateProtoTerrain(
  size: number = PROTO_MAP_SIZE,
  seed: number = PROTO_MAP_SEED,
): TerrainField {
  const rng = createRng(seed);
  const field: TerrainField = [];

  // 2オクターブの値ノイズ。1タイルごとの独立乱数だと山が「紙吹雪」になって
  // 地形として読めないので、粗グリッドを補間して塊にする
  const coarse = noiseGrid(rng, NOISE_RES + 1);
  const fine = noiseGrid(rng, NOISE_RES * 2 + 1);

  // 先に高度を全タイル分求め、その分位点をしきい値にする（面積比を固定するため）
  const heights: number[][] = [];
  const flat: number[] = [];
  for (let y = 0; y < size; y++) {
    const row: number[] = [];
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      const v = y / (size - 1);
      const h = sample(coarse, NOISE_RES, u, v) * 0.7 + sample(fine, NOISE_RES * 2, u, v) * 0.3;
      row.push(h);
      flat.push(h);
    }
    heights.push(row);
  }
  flat.sort((a, b) => a - b);
  const cut = flat[Math.floor(flat.length * (1 - MOUNTAIN_RATIO))] ?? 1;

  for (let y = 0; y < size; y++) {
    const row: ProtoTerrain[] = [];
    for (let x = 0; x < size; x++) {
      row.push((heights[y]?.[x] ?? 0) > cut ? 'mountain' : 'plain');
    }
    field.push(row);
  }

  carveRiver(field, size, rng);
  return field;
}

/**
 * 上から下へ蛇行する川を1本掘る。
 *
 * 重要: 行をまたいで x がずれるとき、その行に x..nextX の水平分も掘る。
 * これをしないと (x, y) と (x±1, y+1) が角でしか接せず、タイルとしては
 * 分断されて見える（実際に「川が繋がっていない」不具合になっていた）。
 * 水平分を埋めることで必ず4近傍で連結する。
 */
function carveRiver(field: TerrainField, size: number, rng: Rng): void {
  let x = Math.floor(size * (0.3 + next(rng) * 0.4));
  for (let y = 0; y < size; y++) {
    x = clampRiverX(x, size);

    // 次の行での位置を先に決め、この行で横に繋いでから下りる
    const r = next(rng);
    const nextX = clampRiverX(r < 0.3 ? x - 1 : r > 0.7 ? x + 1 : x, size);

    const from = Math.min(x, nextX);
    const to = Math.max(x, nextX);
    for (let k = from; k <= to; k++) setWater(field, size, k, y);
    // 川幅を1〜2タイルで揺らす（連結性には影響しない）
    if (next(rng) < 0.55) setWater(field, size, to + 1, y);

    x = nextX;
  }
}

function clampRiverX(x: number, size: number): number {
  return Math.max(1, Math.min(size - 3, x));
}

function setWater(field: TerrainField, size: number, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const row = field[y];
  if (row) row[x] = 'water';
}

function noiseGrid(rng: Rng, n: number): number[][] {
  return Array.from({ length: n }, () => Array.from({ length: n }, () => next(rng)));
}

/** 粗グリッドをバイリニア補間して [0,1) を返す */
function sample(grid: number[][], res: number, u: number, v: number): number {
  const fx = u * res;
  const fy = v * res;
  const x0 = Math.min(res, Math.floor(fx));
  const y0 = Math.min(res, Math.floor(fy));
  const x1 = Math.min(res, x0 + 1);
  const y1 = Math.min(res, y0 + 1);
  const tx = smooth(fx - x0);
  const ty = smooth(fy - y0);
  const a = grid[y0]?.[x0] ?? 0;
  const b = grid[y0]?.[x1] ?? 0;
  const c = grid[y1]?.[x0] ?? 0;
  const d = grid[y1]?.[x1] ?? 0;
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** ワールド座標から地形を引く。範囲外は建設不可扱いの mountain を返す */
export function terrainAtWorld(field: TerrainField, wx: number, wy: number): ProtoTerrain {
  const x = Math.floor(wx);
  const y = Math.floor(wy);
  return field[y]?.[x] ?? 'mountain';
}

/** 山だけ建設不可。水は橋として許可する（3方式共通のルール） */
export function canBuildRoadOn(t: ProtoTerrain): boolean {
  return t !== 'mountain';
}
