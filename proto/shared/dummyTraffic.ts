/**
 * P0 共通のダミー交通（実装書 §19 P0: 固定マップ・車50台）。
 * 3方式で完全に同じロジックを使うことで、比較対象を「操作感と見た目」に絞る。
 *
 * 本番の交通シミュ（実装書 §7）とは別物。渋滞・経済・区画は扱わない。
 */

import { createRng, next, nextInt, type Rng } from '../../src/sim/rng';
import { findPath, type ProtoNetwork } from './network';

export const PROTO_CAR_COUNT = 50;
/** タイル/秒。本番の VMAX とは独立の試作用の値 */
const PROTO_SPEED = 2.5;

interface Car {
  path: string[];
  edgeIndex: number;
  edgeProgress: number;
  /** 経路が失われて待機中 */
  idle: boolean;
}

export interface CarView {
  x: number;
  y: number;
  /** 進行方向（ラジアン）。車体の向き表現に使う */
  angle: number;
}

export class DummyTraffic {
  private cars: Car[] = [];
  private rng: Rng;
  private netVersion = -1;

  constructor(
    private net: ProtoNetwork,
    seed = 20260729,
  ) {
    this.rng = createRng(seed);
  }

  /** dtSeconds ぶん進める。毎フレーム呼ぶ */
  update(dtSeconds: number): void {
    const nodes = this.net.nodes();
    if (nodes.length < 2) {
      this.cars = [];
      return;
    }

    // ネットワークが変わったら、全車の経路を捨てて引き直す
    if (this.net.version !== this.netVersion) {
      this.netVersion = this.net.version;
      for (const car of this.cars) car.idle = true;
    }

    while (this.cars.length < PROTO_CAR_COUNT) {
      this.cars.push({ path: [], edgeIndex: 0, edgeProgress: 0, idle: true });
    }

    for (const car of this.cars) {
      if (car.idle || car.edgeIndex >= car.path.length - 1) {
        this.assignRoute(car, nodes);
        if (car.idle) continue;
      }
      car.edgeProgress += (dtSeconds * PROTO_SPEED) / this.edgeLength(car);
      while (car.edgeProgress >= 1) {
        car.edgeProgress -= 1;
        car.edgeIndex++;
        if (car.edgeIndex >= car.path.length - 1) {
          this.assignRoute(car, nodes);
          break;
        }
      }
    }
  }

  /** 描画用に、現在走っている車の位置と向きを返す */
  views(): CarView[] {
    const out: CarView[] = [];
    for (const car of this.cars) {
      if (car.idle || car.path.length < 2) continue;
      const a = this.net.node(car.path[car.edgeIndex] as string);
      const b = this.net.node(car.path[car.edgeIndex + 1] as string);
      if (!a || !b) continue;
      const p = car.edgeProgress;
      out.push({
        x: a.x + (b.x - a.x) * p,
        y: a.y + (b.y - a.y) * p,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      });
    }
    return out;
  }

  /** 実際に走行中の車の数（デバッグHUD用） */
  activeCount(): number {
    return this.cars.filter((c) => !c.idle).length;
  }

  private edgeLength(car: Car): number {
    const a = this.net.node(car.path[car.edgeIndex] as string);
    const b = this.net.node(car.path[car.edgeIndex + 1] as string);
    if (!a || !b) return 1;
    return Math.max(0.001, Math.hypot(b.x - a.x, b.y - a.y));
  }

  private assignRoute(car: Car, nodes: { id: string }[]): void {
    // 何度も外すと重いので試行回数を制限し、失敗したら次フレームに回す
    for (let attempt = 0; attempt < 6; attempt++) {
      const from = nodes[nextInt(this.rng, 0, nodes.length)];
      const to = nodes[nextInt(this.rng, 0, nodes.length)];
      if (!from || !to || from.id === to.id) continue;
      const path = findPath(this.net, from.id, to.id);
      if (path && path.length >= 2) {
        car.path = path;
        car.edgeIndex = 0;
        car.edgeProgress = next(this.rng) * 0.5;
        car.idle = false;
        return;
      }
    }
    car.idle = true;
  }
}
