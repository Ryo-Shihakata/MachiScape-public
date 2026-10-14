/**
 * グリッド（実装書 §3・§4）。
 * チャンク（32×32）単位の疎な配列で、解放済みエリアだけを保持する。
 * 直列化できるようにチャンクは Record<string, Uint8Array> で持ち、Map は使わない。
 */

import { SPACE } from './balance';
import {
  chunkKey,
  tileKey,
  type Grid,
  type RoadRank,
  type TileKind,
  type TilePos,
  type ZoneType,
} from './types';

const CS = SPACE.CHUNK_SIZE;

/** Uint8Array に詰めるための数値コード。セーブ形式に直結するので値を変えないこと */
export const TERRAIN_CODE: Record<TileKind, number> = {
  plain: 0,
  water: 1,
  mountain: 2,
  forest: 3,
};
const TERRAIN_BY_CODE: TileKind[] = ['plain', 'water', 'mountain', 'forest'];

/** 0 = 区画なし。1 以降が ZoneType */
export const ZONE_CODE: Record<ZoneType, number> = {
  residential: 1,
  commercial: 2,
  industrial: 3,
};
const ZONE_BY_CODE: Array<ZoneType | null> = [null, 'residential', 'commercial', 'industrial'];

export function createGrid(): Grid {
  return { terrain: {}, road: {}, zone: {}, buildingIndex: {}, facilityIndex: {} };
}

/** タイル座標 → チャンク座標。負の座標でも正しく下方向へ丸める */
export function toChunk(x: number, y: number): { cx: number; cy: number } {
  return { cx: Math.floor(x / CS), cy: Math.floor(y / CS) };
}

/** チャンク内のインデックス。負の座標でも 0..CS-1 に収める */
function localIndex(x: number, y: number): number {
  const lx = ((x % CS) + CS) % CS;
  const ly = ((y % CS) + CS) % CS;
  return ly * CS + lx;
}

/** チャンクが解放済みか（= 生成されているか） */
export function hasChunk(grid: Grid, cx: number, cy: number): boolean {
  return grid.terrain[chunkKey(cx, cy)] !== undefined;
}

export function isInsideWorld(grid: Grid, x: number, y: number): boolean {
  const { cx, cy } = toChunk(x, y);
  return hasChunk(grid, cx, cy);
}

/**
 * チャンクを地形付きで登録する。terrain は CS*CS 個の TERRAIN_CODE 値。
 * 既に存在する場合は何もしない（購入の二重適用で地形が作り直されないように）。
 */
export function addChunk(grid: Grid, cx: number, cy: number, terrain: Uint8Array): void {
  const k = chunkKey(cx, cy);
  if (grid.terrain[k]) return;
  if (terrain.length !== CS * CS) {
    throw new Error(`チャンクの地形サイズが不正: ${terrain.length} (期待値 ${CS * CS})`);
  }
  grid.terrain[k] = terrain;
  grid.road[k] = new Uint8Array(CS * CS);
  grid.zone[k] = new Uint8Array(CS * CS);
}

export function terrainAt(grid: Grid, x: number, y: number): TileKind | undefined {
  const { cx, cy } = toChunk(x, y);
  const arr = grid.terrain[chunkKey(cx, cy)];
  if (!arr) return undefined;
  return TERRAIN_BY_CODE[arr[localIndex(x, y)] ?? 0];
}

export function setTerrain(grid: Grid, x: number, y: number, kind: TileKind): void {
  const { cx, cy } = toChunk(x, y);
  const arr = grid.terrain[chunkKey(cx, cy)];
  if (!arr) return;
  arr[localIndex(x, y)] = TERRAIN_CODE[kind];
}

export function hasRoad(grid: Grid, x: number, y: number): boolean {
  return roadRankAt(grid, x, y) > 0;
}

/** 道路ランクを返す。未解放・道路なしは 0。 */
export function roadRankAt(grid: Grid, x: number, y: number): RoadRank {
  const { cx, cy } = toChunk(x, y);
  const arr = grid.road[chunkKey(cx, cy)];
  const rank = arr?.[localIndex(x, y)] ?? 0;
  return rank === 2 ? 2 : rank === 1 ? 1 : 0;
}

/** 既存 API の意味を維持する。true は必ず通常道路（ランク1）を敷く。 */
export function setRoad(grid: Grid, x: number, y: number, present: boolean): void {
  setRoadRank(grid, x, y, present ? 1 : 0);
}

export function setRoadRank(grid: Grid, x: number, y: number, rank: RoadRank): void {
  const { cx, cy } = toChunk(x, y);
  const arr = grid.road[chunkKey(cx, cy)];
  if (!arr) return;
  arr[localIndex(x, y)] = rank;
}

/** 幹線が1タイルでもあるか。Uint8Array#includes でチャンク単位に高速走査する。 */
export function hasArterialRoad(grid: Grid): boolean {
  for (const key in grid.road) {
    const arr = grid.road[key];
    if (!arr) continue;
    if (typeof arr.includes === 'function') {
      if (arr.includes(2)) return true;
      continue;
    }
    // JSON.stringify/parse だけを通したテスト状態は Uint8Array が数値キーの
    // プレーンオブジェクトになる。正式セーブは base64 復元で Uint8Array に戻すが、
    // ランク値そのものを確認できるよう、この形も読み取りだけ許容する。
    for (const index in arr) {
      if (arr[index] === 2) return true;
    }
  }
  return false;
}

export function zoneAt(grid: Grid, x: number, y: number): ZoneType | null {
  const { cx, cy } = toChunk(x, y);
  const arr = grid.zone[chunkKey(cx, cy)];
  if (!arr) return null;
  return ZONE_BY_CODE[arr[localIndex(x, y)] ?? 0] ?? null;
}

export function setZone(grid: Grid, x: number, y: number, zone: ZoneType | null): void {
  const { cx, cy } = toChunk(x, y);
  const arr = grid.zone[chunkKey(cx, cy)];
  if (!arr) return;
  arr[localIndex(x, y)] = zone ? ZONE_CODE[zone] : 0;
}

export function buildingIdAt(grid: Grid, x: number, y: number): number | undefined {
  return grid.buildingIndex[tileKey(x, y)];
}

export function facilityIdAt(grid: Grid, x: number, y: number): number | undefined {
  return grid.facilityIndex[tileKey(x, y)];
}

/** 4近傍。斜めは含めない（実装書 §4） */
export const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function neighbors(pos: TilePos): TilePos[] {
  return NEIGHBOR_OFFSETS.map(([dx, dy]) => ({ x: pos.x + dx, y: pos.y + dy }));
}

export function manhattan(a: TilePos, b: TilePos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** そのタイルに何かを建てられるか（山は不可・世界の外も不可）。水は橋・建物用途で個別判定する */
export function isBuildableTerrain(grid: Grid, x: number, y: number): boolean {
  const t = terrainAt(grid, x, y);
  return t !== undefined && t !== 'mountain';
}

/** 道路から ROAD_ACCESS_DISTANCE 以内に道路タイルがあるか（実装書 §8.2） */
export function hasRoadAccess(grid: Grid, x: number, y: number, distance: number): boolean {
  for (let dy = -distance; dy <= distance; dy++) {
    const rest = distance - Math.abs(dy);
    for (let dx = -rest; dx <= rest; dx++) {
      if (hasRoad(grid, x + dx, y + dy)) return true;
    }
  }
  return false;
}
