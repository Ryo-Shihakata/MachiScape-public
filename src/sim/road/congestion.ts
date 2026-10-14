/**
 * タイルごとの混雑度 0..1（実装書 §6・§7.3）。
 * GameState と同様に直列化可能な疎コンテナとして Record<string, number> で持つ
 * （Map は使わない）。車両の占有数を数える処理そのものは traffic 担当の範囲。
 * ここは混雑度の保持と EMA 更新だけを担う。
 */

import { TRAFFIC } from '../balance';
import { roadRankAt } from '../grid';
import type { Grid } from '../types';

export type CongestionMap = Record<string, number>;

/**
 * この値未満に減衰したエントリは削除する（肥大化防止のしきい値）。
 * balance.ts の Tunable ではなく実装都合の内部定数なので、balance.ts は編集せずここに置く。
 * → balance.ts へ移すべきか要判断（報告参照）。
 */
const PRUNE_EPSILON = 0.001;

export function createCongestionMap(): CongestionMap {
  return {};
}

export function congestionAt(map: CongestionMap, x: number, y: number): number {
  return map[`${x},${y}`] ?? 0;
}

/**
 * 各タイルの `min(occ / CAPACITY, 1)` を目標値として、係数 CONGESTION_ALPHA の
 * 指数移動平均で更新する（実装書 §7.3）。`occupancyByTile` に含まれないが
 * 既に追跡中のタイルは目標値 0（占有なし）として減衰させる。
 * 十分小さくなったタイル（PRUNE_EPSILON 未満）はエントリを削除する。
 */
export function updateCongestion(
  map: CongestionMap,
  occupancyByTile: Record<string, number>,
  grid?: Grid,
): void {
  const keys = new Set<string>([...Object.keys(map), ...Object.keys(occupancyByTile)]);
  for (const key of keys) {
    const occ = occupancyByTile[key] ?? 0;
    let rank = 1;
    if (grid) {
      const separator = key.indexOf(',');
      rank = roadRankAt(grid, Number(key.slice(0, separator)), Number(key.slice(separator + 1)));
    }
    const capacity = TRAFFIC.CAPACITY * (rank === 2 ? TRAFFIC.ARTERIAL_CAPACITY_MULTIPLIER : 1);
    const target = Math.min(occ / capacity, 1);
    const prev = map[key] ?? 0;
    const next = prev + TRAFFIC.CONGESTION_ALPHA * (target - prev);
    if (next < PRUNE_EPSILON) {
      delete map[key];
    } else {
      map[key] = next;
    }
  }
}
