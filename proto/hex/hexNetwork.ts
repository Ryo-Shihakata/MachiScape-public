/**
 * proto/shared/network.ts の ProtoNetwork をヘックスグリッドで実装する。
 * ノードid = "q,r"、座標は axialToWorld で変換したワールド座標（セル中心・タイル単位）。
 * 道路セルをノード、6方向で隣接する道路セルをエッジとする。水セル上の道路は橋として許可し、
 * 山セルには道路を置けない。
 */

import type { NetNode, ProtoNetwork } from '../shared/network';
import { axialKey, axialToWorld, neighborsOf, parseKey } from './hexMath';
import type { Terrain } from './mapgen';

export class HexNetwork implements ProtoNetwork {
  private roads = new Map<string, NetNode>();
  version = 0;

  constructor(private terrain: Map<string, Terrain>) {}

  nodes(): NetNode[] {
    return Array.from(this.roads.values());
  }

  node(id: string): NetNode | undefined {
    return this.roads.get(id);
  }

  neighbors(id: string): string[] {
    const { q, r } = parseKey(id);
    return neighborsOf(q, r)
      .map((n) => axialKey(n.q, n.r))
      .filter((key) => this.roads.has(key));
  }

  hasRoad(q: number, r: number): boolean {
    return this.roads.has(axialKey(q, r));
  }

  /** 山でなければ道路化する（水は橋として許可）。マップ範囲外やすでに道路のセルは何もしない */
  addRoad(q: number, r: number): boolean {
    const key = axialKey(q, r);
    if (this.roads.has(key)) return false;
    const t = this.terrain.get(key);
    if (t === undefined || t === 'mountain') return false;
    const { x, y } = axialToWorld(q, r);
    this.roads.set(key, { id: key, x, y });
    this.version++;
    return true;
  }

  /** 道路を撤去する。道路でなければ何もしない */
  removeRoad(q: number, r: number): boolean {
    const key = axialKey(q, r);
    if (!this.roads.delete(key)) return false;
    this.version++;
    return true;
  }
}
