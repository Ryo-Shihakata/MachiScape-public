/**
 * 道路の経路探索（実装書 §6・D3）。
 *
 * 道路グラフは**8方向接続**（斜めを含む）。斜めを許すのはプレイヤーが斜めの道路を
 * 引けるようにするため。これに伴い次の2点が必須になる:
 *  - 斜め移動の基本コストは √2（1にすると不自然に斜めばかり選ばれる）
 *  - ヒューリスティックはオクタイル距離（マンハッタンだと過大評価で最短性が崩れる）
 *
 * 決定論: 同じ入力で必ず同じ経路を返す。f 値が同じノードの取り出し順が実行ごとに
 * ブレると経路が変わるため、優先度付きキューのタイブレークを明示的に決めてある
 * （f → h → y → x の順。全順序なので同点は起こらない）。
 */

import { ROAD, SPACE } from '../balance';
import type { Grid, TilePos } from '../types';
import { congestionAt, type CongestionMap } from './congestion';
import { diagonalAllowed } from './connectivity';

const CS = SPACE.CHUNK_SIZE;

/**
 * 探索の内側専用の高速な道路参照。
 *
 * grid.ts の `hasRoad` は呼び出しごとにチャンクキーの文字列（`${cx},${cy}`）を作る。
 * A* はノードごとに8方向を見るので、この文字列生成が探索時間の大半を占めていた
 * （実測 2.9ms/回）。チャンク配列を数値キーで引き、直前のチャンクを覚えておくことで、
 * 同一チャンク内の連続アクセスがほぼゼロコストになる。
 */
class RoadReader {
  private chunks = new Map<number, Uint8Array | undefined>();
  private lastKey = NaN;
  private lastArr: Uint8Array | undefined = undefined;

  constructor(private grid: Grid) {}

  has(x: number, y: number): boolean {
    const cx = Math.floor(x / CS);
    const cy = Math.floor(y / CS);
    const ck = cx * 65536 + cy;
    if (ck !== this.lastKey) {
      this.lastKey = ck;
      if (this.chunks.has(ck)) {
        this.lastArr = this.chunks.get(ck);
      } else {
        this.lastArr = this.grid.road[`${cx},${cy}`];
        this.chunks.set(ck, this.lastArr);
      }
    }
    const arr = this.lastArr;
    if (!arr) return false;
    const lx = x - cx * CS;
    const ly = y - cy * CS;
    // grid.road は 1=通常 / 2=幹線。接続規則はランクに依存させない。
    return (arr[ly * CS + lx] ?? 0) > 0;
  }
}

const SQRT2 = Math.SQRT2;

/** 8方向。道路グラフ専用（grid.ts の NEIGHBOR_OFFSETS は4近傍で用途が別） */
export const ROAD_DIRS: ReadonlyArray<readonly [number, number, number]> = [
  // [dx, dy, 基本コスト]
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

/** オクタイル距離。8方向グラフで許容的（実コストを超えない）なヒューリスティック */
export function octile(a: TilePos, b: TilePos): number {
  return octileRaw(a.x, a.y, b.x, b.y);
}

/** 探索の内側から呼ぶ版。オブジェクトを作らないぶん速い */
function octileRaw(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
}

/** タイルへ進入するコスト。混雑しているほど高くなり、自然に迂回が選ばれる */
function enterCost(congestion: CongestionMap, x: number, y: number, base: number): number {
  return base * (1 + ROAD.CONGESTION_WEIGHT * congestionAt(congestion, x, y));
}

/**
 * `findPath` と同じ辺コストで、与えられた経路の現在コストを測る。
 * 動的迂回が A* の選択基準と別の物差しで判断しないための共通ヘルパー。
 */
export function pathCost(congestion: CongestionMap, path: readonly TilePos[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1] as TilePos;
    const to = path[i] as TilePos;
    const base = from.x !== to.x && from.y !== to.y ? SQRT2 : 1;
    total += enterCost(congestion, to.x, to.y, base);
  }
  return total;
}

interface Node {
  x: number;
  y: number;
  g: number;
  f: number;
  h: number;
}

/**
 * 決定論的な優先度付きキュー（二分ヒープ）。
 * 比較は f → h → y → x の全順序なので、同点による順序の揺れが起きない。
 */
class Heap {
  private items: Node[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: Node): void {
    this.items.push(node);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (less(this.items[i] as Node, this.items[parent] as Node)) {
        this.swap(i, parent);
        i = parent;
      } else break;
    }
  }

  pop(): Node | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0] as Node;
    const last = items.pop() as Node;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < items.length && less(items[l] as Node, items[best] as Node)) best = l;
        if (r < items.length && less(items[r] as Node, items[best] as Node)) best = r;
        if (best === i) break;
        this.swap(i, best);
        i = best;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const t = this.items[a] as Node;
    this.items[a] = this.items[b] as Node;
    this.items[b] = t;
  }
}

function less(a: Node, b: Node): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.h !== b.h) return a.h < b.h; // ゴールに近い方を優先（探索が細くなる）
  if (a.y !== b.y) return a.y < b.y;
  return a.x < b.x;
}

/**
 * 座標を単一の整数へ詰める。
 * 文字列キー（`${x},${y}`）は探索1回あたり数万回の文字列生成を招き、
 * 実測で 2.9ms/回かかっていた。数値キー + Map にすることで大幅に速くなる。
 * 扱える座標は ±KEY_BIAS の範囲（チャンク購入で広がる想定の範囲を十分に超える）。
 */
const KEY_BIAS = 1 << 15;
const KEY_STRIDE = 1 << 16;

function key(x: number, y: number): number {
  return (y + KEY_BIAS) * KEY_STRIDE + (x + KEY_BIAS);
}

function keyX(k: number): number {
  return (k % KEY_STRIDE) - KEY_BIAS;
}

function keyY(k: number): number {
  return Math.floor(k / KEY_STRIDE) - KEY_BIAS;
}

/**
 * from から to までの経路（from と to を含むタイル列）。無ければ null。
 * 通れるのは道路タイルのみ。from / to 自身が道路でなければ null。
 */
export function findPath(
  grid: Grid,
  congestion: CongestionMap,
  from: TilePos,
  to: TilePos,
): TilePos[] | null {
  const road = new RoadReader(grid);
  const roadAt = (x: number, y: number): boolean => road.has(x, y);
  if (!road.has(from.x, from.y) || !road.has(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [{ x: from.x, y: from.y }];

  const open = new Heap();
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();

  const h0 = octileRaw(from.x, from.y, to.x, to.y);
  gScore.set(key(from.x, from.y), 0);
  open.push({ x: from.x, y: from.y, g: 0, h: h0, f: h0 });

  while (open.size > 0) {
    const cur = open.pop() as Node;
    const curKey = key(cur.x, cur.y);
    if (closed.has(curKey)) continue;
    closed.add(curKey);

    if (cur.x === to.x && cur.y === to.y) {
      return reconstruct(cameFrom, curKey);
    }

    const curG = gScore.get(curKey) ?? Infinity;
    for (const [dx, dy, base] of ROAD_DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!road.has(nx, ny)) continue;
      // 斜めは「共有する直交隣接がどちらも道路でない」ときだけ通れる（connectivity.ts）。
      // 描画と同じ規則にしないと、画面に無い斜めのショートカットを車が走る
      if (dx !== 0 && dy !== 0 && !diagonalAllowed(roadAt, cur.x, cur.y, dx, dy)) continue;
      const nKey = key(nx, ny);
      if (closed.has(nKey)) continue;

      const tentative = curG + enterCost(congestion, nx, ny, base);
      if (tentative >= (gScore.get(nKey) ?? Infinity)) continue;

      gScore.set(nKey, tentative);
      cameFrom.set(nKey, curKey);
      const h = octileRaw(nx, ny, to.x, to.y);
      open.push({ x: nx, y: ny, g: tentative, h, f: tentative + h });
    }
  }
  return null;
}

function reconstruct(cameFrom: Map<number, number>, endKey: number): TilePos[] {
  const path: TilePos[] = [];
  let k: number | undefined = endKey;
  while (k !== undefined) {
    path.push({ x: keyX(k), y: keyY(k) });
    k = cameFrom.get(k);
  }
  return path.reverse();
}
