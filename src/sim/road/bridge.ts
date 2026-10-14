/**
 * 橋の検証（実装書 §6）。
 *
 * 「連続する水上の橋タイル列は単一方向（全タイル同x または 同y）で、
 *   両端が陸の道路タイルに接続していること」
 *
 * 建設時の検証と、UI のドラッグプレビューの可否表示で同じ関数を使う
 * （二重実装すると「プレビューでは置けるのに建設できない」がすぐ生まれる）。
 */

import { hasRoad, terrainAt } from '../grid';
import type { Grid, TilePos } from '../types';

function isWater(grid: Grid, x: number, y: number): boolean {
  return terrainAt(grid, x, y) === 'water';
}

/** 陸かつ、道路があるか／これから敷かれるタイル */
function isLandAnchor(grid: Grid, x: number, y: number, planned: Set<string>): boolean {
  const t = terrainAt(grid, x, y);
  if (t === undefined || t === 'water' || t === 'mountain') return false;
  return hasRoad(grid, x, y) || planned.has(`${x},${y}`);
}

/**
 * これから敷こうとしているタイル列に含まれる水上区間がすべて橋として妥当か。
 * 水を渡らない（水タイルを含まない）場合は true。
 */
export function validateBridge(grid: Grid, tiles: TilePos[]): boolean {
  const planned = new Set(tiles.map((t) => `${t.x},${t.y}`));

  // タイル列を、連続する水タイルの区間（ラン）に切り出す
  let run: TilePos[] = [];
  for (const t of tiles) {
    if (isWater(grid, t.x, t.y)) {
      run.push(t);
      continue;
    }
    if (run.length > 0) {
      if (!isValidRun(grid, run, planned)) return false;
      run = [];
    }
  }
  if (run.length > 0 && !isValidRun(grid, run, planned)) return false;
  return true;
}

function isValidRun(grid: Grid, run: TilePos[], planned: Set<string>): boolean {
  const first = run[0];
  const last = run[run.length - 1];
  if (!first || !last) return false;

  // 単一方向であること（全タイルが同じ x、または同じ y に並ぶ）
  const sameX = run.every((t) => t.x === first.x);
  const sameY = run.every((t) => t.y === first.y);
  if (!sameX && !sameY) return false;

  // **水が1タイルだけの区間は向きが決まらない**（sameX と sameY が両方 true になる）。
  // ここで縦に決め打ちすると、幅1タイルの川を**横切る橋が永久に架けられない**。
  // 川は幅1〜2タイルで生成され（実装書 §5）、開始チャンクを必ず1本通るので、
  // これは日常的に踏む経路になる。両方の向きを試し、どちらかで成立すれば通す。
  if (run.length === 1) {
    return anchoredAlong(grid, run, planned, true) || anchoredAlong(grid, run, planned, false);
  }

  // 区間が連続していること（間が飛んでいたら別の橋なので不正）
  if (sameX) {
    const ys = run.map((t) => t.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++)
      if ((ys[i] as number) - (ys[i - 1] as number) !== 1) return false;
  } else {
    const xs = run.map((t) => t.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++)
      if ((xs[i] as number) - (xs[i - 1] as number) !== 1) return false;
  }

  return anchoredAlong(grid, run, planned, sameX);
}

/**
 * 水上区間の両端の外側が、陸の道路（既設 or 同じ操作で敷かれる）に繋がっているか。
 * `vertical` が true なら縦向きの橋として、false なら横向きとして端を見る。
 */
function anchoredAlong(
  grid: Grid,
  run: TilePos[],
  planned: Set<string>,
  vertical: boolean,
): boolean {
  const dir = vertical ? { dx: 0, dy: 1 } : { dx: 1, dy: 0 };
  const lo = vertical
    ? run.reduce((a, b) => (a.y <= b.y ? a : b))
    : run.reduce((a, b) => (a.x <= b.x ? a : b));
  const hi = vertical
    ? run.reduce((a, b) => (a.y >= b.y ? a : b))
    : run.reduce((a, b) => (a.x >= b.x ? a : b));

  const before = { x: lo.x - dir.dx, y: lo.y - dir.dy };
  const after = { x: hi.x + dir.dx, y: hi.y + dir.dy };
  return (
    isLandAnchor(grid, before.x, before.y, planned) && isLandAnchor(grid, after.x, after.y, planned)
  );
}
