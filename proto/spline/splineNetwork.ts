/**
 * P0 自由曲線方式: ProtoNetwork の実装（依頼書 やること3）。
 *
 * 道路はアンカー点列から作った曲線を弧長一定間隔（0.5〜1タイル）でサンプルし、
 * サンプル点をノード、隣接サンプル点をエッジとして表現する。
 * 既存の道への接続（始点・終点のスナップ）と、他の道との交差（分岐点の自動挿入）を
 * この中でだけ扱う。交通ロジック（findPath / DummyTraffic）は proto/shared 側に任せる。
 */

import type { NetNode, ProtoNetwork } from '../shared/network';
import type { Vec2 } from '../../src/render/camera';
import { evaluateCatmullRom, resampleByArcLength } from './curve';

/** タイル単位。依頼書の指定範囲(0.5〜1)の中央寄り */
const SAMPLE_SPACING = 0.65;
/** 既存ノードの近くならそこに接続とみなす半径 */
const SNAP_NODE_RADIUS = 0.4;
/** 既存エッジの近くなら、その上に分岐点を割り込ませる半径 */
const SNAP_EDGE_RADIUS = 0.35;
/** 消しゴムの半径 */
const ERASE_RADIUS = 0.6;
/** 交差判定で端点ぎりぎりを誤検出しないための余白（t/u比率） */
const CROSS_EPS = 0.02;

export interface EdgeRef {
  a: string;
  b: string;
}

function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): { x: number; y: number; t: number; dist: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq < 1e-9 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return { x, y, t, dist: Math.hypot(p.x - x, p.y - y) };
}

/** 2線分 p1-p2 と p3-p4 の交点。平行なら null。t は p1-p2 上、u は p3-p4 上の媒介変数 */
function segmentIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): { x: number; y: number; t: number; u: number } | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null; // 平行 or 縮退
  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  const t = (dx * d2y - dy * d2x) / denom;
  const u = (dx * d1y - dy * d1x) / denom;
  return { x: p1.x + d1x * t, y: p1.y + d1y * t, t, u };
}

export class SplineNetwork implements ProtoNetwork {
  private nodeMap = new Map<string, NetNode>();
  private adj = new Map<string, Set<string>>();
  private seq = 0;
  version = 0;

  nodes(): NetNode[] {
    return [...this.nodeMap.values()];
  }

  node(id: string): NetNode | undefined {
    return this.nodeMap.get(id);
  }

  neighbors(id: string): string[] {
    return [...(this.adj.get(id) ?? [])];
  }

  /** 描画用: 全エッジを重複なく列挙する */
  edges(): EdgeRef[] {
    const out: EdgeRef[] = [];
    const seen = new Set<string>();
    for (const [a, nbs] of this.adj) {
      for (const b of nbs) {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ a, b });
      }
    }
    return out;
  }

  private createNode(x: number, y: number): NetNode {
    const id = `n${this.seq++}`;
    const node: NetNode = { id, x, y };
    this.nodeMap.set(id, node);
    this.adj.set(id, new Set());
    return node;
  }

  private connect(a: string, b: string): void {
    if (a === b) return;
    this.adj.get(a)?.add(b);
    this.adj.get(b)?.add(a);
  }

  private disconnect(a: string, b: string): void {
    this.adj.get(a)?.delete(b);
    this.adj.get(b)?.delete(a);
  }

  private removeNode(id: string): void {
    const nbs = this.adj.get(id);
    if (nbs) for (const nb of [...nbs]) this.disconnect(id, nb);
    this.adj.delete(id);
    this.nodeMap.delete(id);
  }

  private findNearNode(x: number, y: number, radius: number): NetNode | undefined {
    let best: NetNode | undefined;
    let bestDist = radius;
    for (const n of this.nodeMap.values()) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bestDist) {
        bestDist = d;
        best = n;
      }
    }
    return best;
  }

  private findNearEdgePoint(x: number, y: number, radius: number): (EdgeRef & { x: number; y: number }) | undefined {
    let best: (EdgeRef & { x: number; y: number; dist: number }) | undefined;
    for (const e of this.edges()) {
      const a = this.nodeMap.get(e.a);
      const b = this.nodeMap.get(e.b);
      if (!a || !b) continue;
      const cp = closestPointOnSegment({ x, y }, a, b);
      if (cp.t <= 0.02 || cp.t >= 0.98) continue; // 端点付近はノードスナップに任せる
      if (cp.dist <= radius && (!best || cp.dist < best.dist)) {
        best = { a: e.a, b: e.b, x: cp.x, y: cp.y, dist: cp.dist };
      }
    }
    return best;
  }

  private splitEdge(a: string, b: string, x: number, y: number): string {
    this.disconnect(a, b);
    const mid = this.createNode(x, y);
    this.connect(a, mid.id);
    this.connect(mid.id, b);
    return mid.id;
  }

  private snapOrCreate(p: Vec2): string {
    const near = this.findNearNode(p.x, p.y, SNAP_NODE_RADIUS);
    if (near) return near.id;
    const edge = this.findNearEdgePoint(p.x, p.y, SNAP_EDGE_RADIUS);
    if (edge) return this.splitEdge(edge.a, edge.b, edge.x, edge.y);
    return this.createNode(p.x, p.y).id;
  }

  /**
   * na-nb を結ぶ。その途中で既存の道と交差していれば、交点にノードを挿入して
   * 分岐・交差点にする（依頼書 やること2: 分岐と交差を許可する）。
   */
  private connectWithCrossings(na: string, nb: string): void {
    const a = this.nodeMap.get(na);
    const b = this.nodeMap.get(nb);
    if (!a || !b) return;

    const hits: { t: number; x: number; y: number; ea: string; eb: string }[] = [];
    for (const e of this.edges()) {
      if (e.a === na || e.a === nb || e.b === na || e.b === nb) continue;
      const ea = this.nodeMap.get(e.a);
      const eb = this.nodeMap.get(e.b);
      if (!ea || !eb) continue;
      const hit = segmentIntersect(a, b, ea, eb);
      if (!hit) continue;
      if (hit.t <= CROSS_EPS || hit.t >= 1 - CROSS_EPS) continue;
      if (hit.u <= CROSS_EPS || hit.u >= 1 - CROSS_EPS) continue;
      hits.push({ t: hit.t, x: hit.x, y: hit.y, ea: e.a, eb: e.b });
    }
    hits.sort((h1, h2) => h1.t - h2.t);

    let prev = na;
    for (const h of hits) {
      const existing = this.findNearNode(h.x, h.y, SNAP_NODE_RADIUS * 0.5);
      const mid = existing ? existing.id : this.splitEdge(h.ea, h.eb, h.x, h.y);
      if (mid !== prev) this.connect(prev, mid);
      prev = mid;
    }
    if (prev !== nb) this.connect(prev, nb);
  }

  /** ドラッグで集めたアンカー点列から道を作る。アンカーが2点未満なら何もしない */
  buildRoad(anchors: Vec2[]): boolean {
    if (anchors.length < 2) return false;
    const dense = evaluateCatmullRom(anchors);
    const samples = resampleByArcLength(dense, SAMPLE_SPACING);
    if (samples.length < 2) return false;

    let prevId = this.snapOrCreate(samples[0]!);
    for (let i = 1; i < samples.length; i++) {
      const isLast = i === samples.length - 1;
      const p = samples[i]!;
      const id = isLast ? this.snapOrCreate(p) : this.createNode(p.x, p.y).id;
      this.connectWithCrossings(prevId, id);
      prevId = id;
    }
    this.version++;
    return true;
  }

  /** 消しゴム。半径内のノードをまとめて削除する。何か消えたら true */
  eraseAt(x: number, y: number, radius = ERASE_RADIUS): boolean {
    const targets = [...this.nodeMap.values()].filter((n) => Math.hypot(n.x - x, n.y - y) <= radius);
    if (targets.length === 0) return false;
    for (const t of targets) this.removeNode(t.id);
    this.version++;
    return true;
  }
}
