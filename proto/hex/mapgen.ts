/**
 * P0 ヘックス試作の地形。
 * 生成そのものは proto/shared/terrain.ts（3方式共通）に委譲し、
 * 各セルの中心ワールド座標を共通地形フィールドへ正規化サンプリングして割り当てる。
 *
 * 3方式が同じ地形の上で比較できないと、D1 で比べているのが空間モデルではなく
 * 地形になってしまうため。ヘックスは正方タイルではないので、セル単位の一致ではなく
 * 「同じ位置に同じ地形が見える」ことを担保する。
 */

import {
  PROTO_MAP_SEED,
  PROTO_MAP_SIZE,
  generateProtoTerrain,
  terrainAtWorld,
  type ProtoTerrain,
} from '../shared/terrain';
import { axialKey, axialToWorld } from './hexMath';

export type Terrain = ProtoTerrain;

export const MAP_SEED = PROTO_MAP_SEED;
export const Q_COUNT = 48;
export const R_COUNT = 48;
export const R_MIN = -Math.floor(R_COUNT / 2);

/** r 行における q の最小値（行ごとのオフセット補正で全体を矩形に近い形にする） */
export function rowQMin(r: number): number {
  return -Math.floor(Q_COUNT / 2) - Math.floor(r / 2);
}

export function inMap(q: number, r: number): boolean {
  if (r < R_MIN || r >= R_MIN + R_COUNT) return false;
  const qMin = rowQMin(r);
  return q >= qMin && q < qMin + Q_COUNT;
}

export function generateTerrain(seed = MAP_SEED): Map<string, Terrain> {
  const field = generateProtoTerrain(PROTO_MAP_SIZE, seed);
  const terrain = new Map<string, Terrain>();

  // 全セルのワールド座標の外接矩形を求め、共通地形フィールドへ線形写像する
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let r = R_MIN; r < R_MIN + R_COUNT; r++) {
    const qMin = rowQMin(r);
    for (let q = qMin; q < qMin + Q_COUNT; q++) {
      const w = axialToWorld(q, r);
      if (w.x < minX) minX = w.x;
      if (w.x > maxX) maxX = w.x;
      if (w.y < minY) minY = w.y;
      if (w.y > maxY) maxY = w.y;
    }
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);

  for (let r = R_MIN; r < R_MIN + R_COUNT; r++) {
    const qMin = rowQMin(r);
    for (let q = qMin; q < qMin + Q_COUNT; q++) {
      const w = axialToWorld(q, r);
      const fx = ((w.x - minX) / spanX) * (PROTO_MAP_SIZE - 1);
      const fy = ((w.y - minY) / spanY) * (PROTO_MAP_SIZE - 1);
      terrain.set(axialKey(q, r), terrainAtWorld(field, fx, fy));
    }
  }

  return terrain;
}
