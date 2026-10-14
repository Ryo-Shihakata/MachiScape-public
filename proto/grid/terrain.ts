/**
 * P0 グリッド試作の地形。
 * 生成そのものは proto/shared/terrain.ts（3方式共通）に委譲する。
 * 3方式が同じ地形の上で比較できないと、D1 で比べているのが空間モデルではなく
 * 地形になってしまうため。
 */
import {
  PROTO_MAP_SEED,
  PROTO_MAP_SIZE,
  canBuildRoadOn,
  generateProtoTerrain,
  type ProtoTerrain,
} from '../shared/terrain';

export const MAP_SIZE = PROTO_MAP_SIZE;
export const MAP_SEED = PROTO_MAP_SEED;

export type TileKind = ProtoTerrain;

export function generateTerrain(size: number, seed: number): TileKind[][] {
  return generateProtoTerrain(size, seed);
}

export function tileAt(grid: TileKind[][], x: number, y: number): TileKind | undefined {
  return grid[y]?.[x];
}

export function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size;
}

/** 道路が置けるか（山は不可。水は橋として許可） */
export function canBuildRoad(grid: TileKind[][], size: number, x: number, y: number): boolean {
  if (!inBounds(size, x, y)) return false;
  const t = tileAt(grid, x, y);
  return t !== undefined && canBuildRoadOn(t);
}
