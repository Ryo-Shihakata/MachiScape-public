import { describe, it, expect } from 'vitest';
import { rectTiles, interpolateVehicleViews, nextIntersectionAxis } from './loop';
import type { VehicleView } from '../sim/traffic';
import type { IntersectionAxis } from '../sim/types';

/**
 * `rectTiles` は区画・撤去ツールの矩形ドラッグ（実装書 §12.3・docs/m3-plan.md §4 W1-2）が
 * 使う純粋関数。ドラッグの開始点・終了点の順序に関わらず同じ矩形になることをテストする
 * （受け入れ基準: 「矩形の範囲計算は開始点と終了点の順序が逆でも同じ矩形になること」）。
 */
describe('rectTiles', () => {
  it('開始点と終了点の順序が逆でも同じ矩形になる', () => {
    const a = { x: 3, y: 5 };
    const b = { x: 7, y: 2 };
    const forward = rectTiles(a, b);
    const backward = rectTiles(b, a);
    expect(backward).toEqual(forward);
    expect(forward).toHaveLength((7 - 3 + 1) * (5 - 2 + 1));
  });

  it('1点だけのドラッグ（タップ）は1タイルの矩形になる', () => {
    const p = { x: 4, y: 4 };
    expect(rectTiles(p, p)).toEqual([{ x: 4, y: 4 }]);
  });

  it('矩形の四隅をすべて含む', () => {
    const tiles = rectTiles({ x: 0, y: 0 }, { x: 2, y: 1 });
    const has = (x: number, y: number) => tiles.some((t) => t.x === x && t.y === y);
    expect(has(0, 0)).toBe(true);
    expect(has(2, 0)).toBe(true);
    expect(has(0, 1)).toBe(true);
    expect(has(2, 1)).toBe(true);
    expect(tiles).toHaveLength(6);
  });

  it('x・yどちらか一方の順序だけが逆でも同じ矩形になる', () => {
    const forward = rectTiles({ x: 1, y: 8 }, { x: 5, y: 2 });
    const xSwapped = rectTiles({ x: 5, y: 8 }, { x: 1, y: 2 });
    const ySwapped = rectTiles({ x: 1, y: 2 }, { x: 5, y: 8 });
    expect(xSwapped).toEqual(forward);
    expect(ySwapped).toEqual(forward);
  });
});

/**
 * `nextIntersectionAxis` は「交通」ツールのタップ巡回（`docs/m4-ui-design.md` §1.2）を
 * 担う純粋関数: 指定なし → 東西を優先 → 南北を優先 → 指定なし → …
 * ダイアログを出さずタップ即時反映にするための唯一のロジックなので、
 * 巡回順そのものをここで固定する。
 */
describe('nextIntersectionAxis', () => {
  it('指定なし（null）から東西（horizontal）へ進む', () => {
    expect(nextIntersectionAxis(null)).toBe('horizontal');
  });

  it('東西（horizontal）から南北（vertical）へ進む', () => {
    expect(nextIntersectionAxis('horizontal')).toBe('vertical');
  });

  it('南北（vertical）から指定なし（null）へ戻る', () => {
    expect(nextIntersectionAxis('vertical')).toBe(null);
  });

  it('4回タップすると1周して同じ値に戻る', () => {
    let axis: IntersectionAxis | null = null;
    const seen: (IntersectionAxis | null)[] = [axis];
    for (let i = 0; i < 3; i++) {
      axis = nextIntersectionAxis(axis);
      seen.push(axis);
    }
    expect(seen).toEqual([null, 'horizontal', 'vertical', null]);
  });
});

/** テスト用に最小限の VehicleView を作る（`overrides` で必要なフィールドだけ上書き） */
function makeView(overrides: Partial<VehicleView> & { id: number }): VehicleView {
  return {
    x: 0,
    y: 0,
    angle: 0,
    kind: 'car',
    leg: 'outbound',
    edgeProgress: 0.5,
    exitEdge: false,
    entranceEdge: false,
    exitPos: { x: 0, y: 0 },
    entrancePos: { x: 0, y: 0 },
    ...overrides,
  };
}

/**
 * `interpolateVehicleViews` は tick境界（10 tick/秒）をまたぐ描画のカクつきを消す
 * 補間関数（実装書 §2.1 / GPT-5レビュー「tick境界をまたぐ補間」）。
 */
describe('interpolateVehicleViews', () => {
  it('前フレームに存在しない id は補間せずそのまま返す（新規出現・滞在明けの復路開始）', () => {
    const prev = new Map<number, VehicleView>(); // 空＝前フレームに誰もいない
    const curr = [makeView({ id: 1, x: 3.5, y: 2.5, angle: 0 })];
    const out = interpolateVehicleViews(prev, curr, 0.5);
    expect(out).toEqual(curr);
  });

  it('前後の位置が1タイル以上離れていたら補間せず現在位置を使う（迂回・倍速の巻き戻し防止）', () => {
    const prev = new Map<number, VehicleView>([
      [1, makeView({ id: 1, x: 0, y: 0, angle: 0 })],
    ]);
    const curr = [makeView({ id: 1, x: 5, y: 0, angle: 0 })]; // 5タイル離れている
    const out = interpolateVehicleViews(prev, curr, 0.5);
    expect(out).toEqual(curr);
  });

  it('直進中（同じ向き）は前後の位置を alpha で線形補間する', () => {
    const prev = new Map<number, VehicleView>([
      [1, makeView({ id: 1, x: 1.5, y: 0.5, angle: 0 })],
    ]);
    const curr = [makeView({ id: 1, x: 1.8, y: 0.5, angle: 0 })];
    const out = interpolateVehicleViews(prev, curr, 0.5);
    expect(out[0]!.x).toBeCloseTo(1.65, 6); // (1.5+1.8)/2
    expect(out[0]!.y).toBeCloseTo(0.5, 6);
    expect(out[0]!.angle).toBeCloseTo(0, 6);
  });

  it('alpha=0 では前フレームの位置、alpha=1 では現フレームの位置に一致する', () => {
    const prev = new Map<number, VehicleView>([
      [1, makeView({ id: 1, x: 1.5, y: 0.5, angle: 0 })],
    ]);
    const curr = [makeView({ id: 1, x: 1.8, y: 0.5, angle: 0 })];
    const at0 = interpolateVehicleViews(prev, curr, 0)[0]!;
    const at1 = interpolateVehicleViews(prev, curr, 1)[0]!;
    expect(at0.x).toBeCloseTo(1.5, 6);
    expect(at0.y).toBeCloseTo(0.5, 6);
    expect(at1.x).toBeCloseTo(1.8, 6);
    expect(at1.y).toBeCloseTo(0.5, 6);
  });

  it('曲がり角をまたぐ場合はフィレット（2次ベジェ）で補間し、辺の外側へはみ出さない', () => {
    // タイル(0,0)→(1,0)を+x方向に走行中（辺の終端付近）。角のタイル中心は(1.5,0.5)。
    const prev = new Map<number, VehicleView>([
      [1, makeView({ id: 1, x: 1.4, y: 0.5, angle: 0 })],
    ]);
    // 直後、タイル(1,0)→(1,1)へ折れて+y方向に走行中（辺の始端付近）
    const curr = [makeView({ id: 1, x: 1.5, y: 0.6, angle: Math.PI / 2 })];

    const mid = interpolateVehicleViews(prev, curr, 0.5)[0]!;

    // 直線補間（単純な中点）とは異なる曲線を通る
    const linearMidX = (1.4 + 1.5) / 2;
    const linearMidY = (0.5 + 0.6) / 2;
    expect(Math.abs(mid.x - linearMidX) + Math.abs(mid.y - linearMidY)).toBeGreaterThan(1e-6);

    // それでも prev/curr が作る矩形（道路が通っている範囲）の外へは出ない
    expect(mid.x).toBeGreaterThanOrEqual(1.4);
    expect(mid.x).toBeLessThanOrEqual(1.5);
    expect(mid.y).toBeGreaterThanOrEqual(0.5);
    expect(mid.y).toBeLessThanOrEqual(0.6);

    // 向きはprevの角度(0)とcurrの角度(π/2)のちょうど中間（π/4）まで滑らかに変わる
    expect(mid.angle).toBeCloseTo(Math.PI / 4, 6);

    // 境界では向きも位置も端点そのものに一致する（横滑りしない）
    const at0 = interpolateVehicleViews(prev, curr, 0)[0]!;
    const at1 = interpolateVehicleViews(prev, curr, 1)[0]!;
    expect(at0.x).toBeCloseTo(1.4, 6);
    expect(at0.y).toBeCloseTo(0.5, 6);
    expect(at0.angle).toBeCloseTo(0, 6);
    expect(at1.x).toBeCloseTo(1.5, 6);
    expect(at1.y).toBeCloseTo(0.6, 6);
    expect(at1.angle).toBeCloseTo(Math.PI / 2, 6);
  });

  it('edgeProgress など位置・向き以外のフィールドは現フレームの値をそのまま保つ', () => {
    const prev = new Map<number, VehicleView>([
      [1, makeView({ id: 1, x: 0, y: 0, angle: 0, edgeProgress: 0.9 })],
    ]);
    const curr = [
      makeView({
        id: 1,
        x: 0.2,
        y: 0,
        angle: 0,
        edgeProgress: 0.1,
        kind: 'truck',
        leg: 'return',
        exitEdge: true,
      }),
    ];
    const out = interpolateVehicleViews(prev, curr, 0.5)[0]!;
    expect(out.edgeProgress).toBe(0.1);
    expect(out.kind).toBe('truck');
    expect(out.leg).toBe('return');
    expect(out.exitEdge).toBe(true);
  });
});
