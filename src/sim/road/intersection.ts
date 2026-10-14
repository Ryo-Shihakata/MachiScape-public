/**
 * 最小の交差点形状判定。
 *
 * 今回扱うのは、中心の斜め4タイルが空いている孤立した直交T字・十字だけ。
 * 斜め道路や道路塊を保守的に除外し、対応外の形を誤って交通制御しない。
 */

import { hasRoad } from '../grid';
import type { Grid, IntersectionAxis, TilePos } from '../types';
import { diagonalAllowed } from './connectivity';

/** 直交4方向のうち、その向きに道路があるかどうか（M5 §4-1）。 */
export interface IntersectionDirections {
  east: boolean;
  west: boolean;
  south: boolean;
  north: boolean;
}

export interface OrthogonalIntersection {
  pos: TilePos;
  connections: number;
  /**
   * 描画専用の付加情報。`gameScene.ts` の停止線が「道路のある向きにだけ」出すために使う
   * （T字路で道路の無い側にも停止線が出ていたバグの修正）。
   *
   * **sim の通行判定はこれを見ない。** `approachAxis` と `connections`（対象形状かどうか）
   * だけで決まるので、ここを足しても既存の交通整理・信号のロジックは変わらない。
   */
  directions: IntersectionDirections;
}

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** 道路グラフと同じ接続規則で、制御対象の孤立した直交交差点だけを返す。 */
export function orthogonalIntersectionAt(
  grid: Grid,
  x: number,
  y: number,
): OrthogonalIntersection | null {
  if (!hasRoad(grid, x, y)) return null;

  const roadAt = (rx: number, ry: number): boolean => hasRoad(grid, rx, ry);
  let connections = 0;
  const directions: IntersectionDirections = { east: false, west: false, south: false, north: false };
  for (const [dx, dy] of DIRECTIONS) {
    if (!roadAt(x + dx, y + dy)) continue;
    if (dx !== 0 && dy !== 0) {
      // 生の8近傍ではなく、経路探索と同じ規則で接続を判断する。
      if (diagonalAllowed(roadAt, x, y, dx, dy)) return null;
      // 接続しない斜め道路も複合形状の印なので、この垂直スライスでは扱わない。
      return null;
    }
    connections++;
    // DIRECTIONS の先頭4件（この分岐に入るのは常にそのどれか）を東西南北へ writeする。
    // y はタイル座標で下向きが正なので、dy=+1 が南・dy=-1 が北。
    if (dx === 1) directions.east = true;
    else if (dx === -1) directions.west = true;
    else if (dy === 1) directions.south = true;
    else directions.north = true;
  }

  return connections >= 3 ? { pos: { x, y }, connections, directions } : null;
}

/** 交差点へ入る辺が属する軸。対象形状では進入辺は必ず直交である。 */
export function approachAxis(from: TilePos, intersection: TilePos): IntersectionAxis {
  return from.x !== intersection.x ? 'horizontal' : 'vertical';
}
