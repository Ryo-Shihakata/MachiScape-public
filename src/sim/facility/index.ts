/**
 * 施設の占有範囲と、座標ごとに解決した効果。
 *
 * 同じ定義の施設が重なって効く場合は1回だけ、異なる定義の効果はそれぞれ適用する。
 * 施設の配列順ではなく `FACILITY_DEFS` の定義順を基準にして、走査順を固定する。
 */

import type { FacilityDef } from './defs';
import { FACILITY_DEFS, facilityDef } from './defs';
import type { GameState, TilePos } from '../types';

/** footprint=4 は pos を左上とする2x2。それ以外は1x1。 */
export function facilityTiles(pos: TilePos, footprint: FacilityDef['footprint']): TilePos[] {
  const size = footprint === 4 ? 2 : 1;
  const tiles: TilePos[] = [];
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) tiles.push({ x: pos.x + dx, y: pos.y + dy });
  }
  return tiles;
}

/** 点から施設の占有矩形までのチェビシェフ距離。占有タイル上なら0。 */
export function chebyshevDistanceToFacility(
  pos: TilePos,
  facilityPos: TilePos,
  footprint: FacilityDef['footprint'],
): number {
  const size = footprint === 4 ? 2 : 1;
  const right = facilityPos.x + size - 1;
  const bottom = facilityPos.y + size - 1;
  const dx = pos.x < facilityPos.x ? facilityPos.x - pos.x : pos.x > right ? pos.x - right : 0;
  const dy = pos.y < facilityPos.y ? facilityPos.y - pos.y : pos.y > bottom ? pos.y - bottom : 0;
  return Math.max(dx, dy);
}

/**
 * 住宅に効く満足度の絶対下限。
 *
 * 同じ公園を複数置いても加算せず、異なる施設が下限を持つ場合も最も強い下限を採る。
 * 下限以外の効果（通学需要など）は別に適用されるため、異種効果は同時に成立する。
 */
export function satisfactionFloorAt(state: GameState, pos: TilePos): number {
  let floor = 0;
  const appliedDefs = new Set<string>();
  for (const facility of state.facilities) {
    if (appliedDefs.has(facility.defId)) continue;
    const def = facilityDef(facility.defId);
    if (!def || def.satisfactionFloor <= 0) continue;
    if (chebyshevDistanceToFacility(pos, facility.pos, def.footprint) > def.radius) continue;
    appliedDefs.add(facility.defId);
    floor = Math.max(floor, def.satisfactionFloor);
  }
  return floor;
}

export interface ExtraTripTarget {
  facilityId: number;
  defId: string;
  pos: TilePos;
  footprint: FacilityDef['footprint'];
  rate: number;
}

/**
 * この住宅から追加トリップを発生させる施設。
 *
 * 同じ種類が複数届く場合、確率は累積させず最寄りの1施設だけを目的地にする。
 * 同距離は id の小さい施設を選び、異なる種類は定義順にそれぞれ返す。
 */
export function extraTripTargetsAt(state: GameState, pos: TilePos): ExtraTripTarget[] {
  const targets: ExtraTripTarget[] = [];
  for (const def of FACILITY_DEFS) {
    if (def.extraTripRate <= 0) continue;
    let best: GameState['facilities'][number] | undefined;
    let bestDistance = Infinity;
    for (const facility of state.facilities) {
      if (facility.defId !== def.id) continue;
      const distance = chebyshevDistanceToFacility(pos, facility.pos, def.footprint);
      if (distance > def.radius) continue;
      if (
        distance < bestDistance ||
        (distance === bestDistance && best !== undefined && facility.id < best.id)
      ) {
        best = facility;
        bestDistance = distance;
      }
    }
    if (!best) continue;
    targets.push({
      facilityId: best.id,
      defId: def.id,
      pos: { x: best.pos.x, y: best.pos.y },
      footprint: def.footprint,
      rate: def.extraTripRate,
    });
  }
  return targets;
}
