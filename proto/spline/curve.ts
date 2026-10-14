/**
 * P0 自由曲線方式: アンカー点列から滑らかな曲線を作るための純粋関数群。
 * Catmull-Rom で密なポリラインを作り、そのあと弧長一定間隔で再サンプルする。
 */

import type { Vec2 } from '../../src/render/camera';

const STEPS_PER_SEGMENT = 16;

function catmullRomPoint(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

/** アンカー列を Catmull-Rom で滑らかに繋ぎ、密なポリラインに変換する */
export function evaluateCatmullRom(anchors: Vec2[]): Vec2[] {
  if (anchors.length < 2) return anchors.slice();
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  // 両端の仮想制御点として自身を複製する（クランプ端点）
  const pts = [first, ...anchors, last];
  const dense: Vec2[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const p2 = pts[i + 2]!;
    const p3 = pts[i + 3]!;
    for (let s = 0; s < STEPS_PER_SEGMENT; s++) {
      dense.push(catmullRomPoint(p0, p1, p2, p3, s / STEPS_PER_SEGMENT));
    }
  }
  dense.push(last);
  return dense;
}

/** 密なポリラインを弧長一定間隔（spacing）で再サンプルする */
export function resampleByArcLength(dense: Vec2[], spacing: number): Vec2[] {
  if (dense.length === 0) return [];
  const out: Vec2[] = [dense[0]!];
  let carry = 0;
  for (let i = 1; i < dense.length; i++) {
    let a = dense[i - 1]!;
    const b = dense[i]!;
    let segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-9) continue;
    while (carry + segLen >= spacing) {
      const t = (spacing - carry) / segLen;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(p);
      a = p;
      segLen = Math.hypot(b.x - a.x, b.y - a.y);
      carry = 0;
    }
    carry += segLen;
  }
  const last = dense[dense.length - 1]!;
  const lastOut = out[out.length - 1]!;
  if (Math.hypot(last.x - lastOut.x, last.y - lastOut.y) > 1e-6) out.push(last);
  return out;
}
