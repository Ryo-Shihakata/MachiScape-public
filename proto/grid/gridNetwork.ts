/**
 * P0 グリッド試作: ProtoNetwork 実装（proto/shared/network.ts 契約 / proto/README.md）。
 * 道路タイルをノード、**8方向**の隣接道路をエッジとするグラフ。
 * ノードidは "x,y"（タイル整数座標そのもの）、座標はタイル中心 (x+0.5, y+0.5)。
 *
 * 斜めを含めるのは、プレイヤーが斜めの道路を引けるようにするため（D2改訂）。
 * 4方向のままだと斜めのタイル列は角でしか接せず、見た目は道なのに車が走れない。
 */
import type { NetNode, ProtoNetwork } from '../shared/network';

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export class GridNetwork implements ProtoNetwork {
  private roads = new Set<string>();
  version = 0;

  has(x: number, y: number): boolean {
    return this.roads.has(key(x, y));
  }

  /** 現在の道路タイルの id 一覧（描画で使う） */
  tiles(): string[] {
    return [...this.roads];
  }

  addRoad(x: number, y: number): void {
    const k = key(x, y);
    if (this.roads.has(k)) return;
    this.roads.add(k);
    this.version++;
  }

  removeRoad(x: number, y: number): void {
    const k = key(x, y);
    if (!this.roads.has(k)) return;
    this.roads.delete(k);
    this.version++;
  }

  nodes(): NetNode[] {
    return [...this.roads].map((k) => toNode(k));
  }

  node(id: string): NetNode | undefined {
    return this.roads.has(id) ? toNode(id) : undefined;
  }

  neighbors(id: string): string[] {
    const [x, y] = parseKey(id);
    const out: string[] = [];
    for (const [dx, dy] of DIRS) {
      const nk = key(x + dx, y + dy);
      if (this.roads.has(nk)) out.push(nk);
    }
    return out;
  }
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function parseKey(k: string): [number, number] {
  const parts = k.split(',');
  return [Number(parts[0]), Number(parts[1])];
}

function toNode(k: string): NetNode {
  const [x, y] = parseKey(k);
  return { id: k, x: x + 0.5, y: y + 0.5 };
}
