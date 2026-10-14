/**
 * P0 自由曲線試作の地形。
 * 生成そのものは proto/shared/terrain.ts（3方式共通）に委譲する。
 * 3方式が同じ地形の上で比較できないと、D1 で比べているのが空間モデルではなく
 * 地形になってしまうため。
 */
import { PROTO_MAP_SIZE, generateProtoTerrain, type ProtoTerrain } from '../shared/terrain';

export type TerrainKind = ProtoTerrain;

export const WORLD_TILES = PROTO_MAP_SIZE;

export function generateTerrain(seed: number): TerrainKind[][] {
  return generateProtoTerrain(PROTO_MAP_SIZE, seed);
}
