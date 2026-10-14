import { describe, it, expect } from 'vitest';
import {
  brakeIntensity,
  carRenderState,
  carDimensions,
  facilityFootprintTiles,
  facilityPlacementValid,
  facilityRadiusBounds,
  intersectionStopLineDirections,
  listBuyableChunks,
  pickVehicleAt,
  roadRenderWidth,
  vehicleLaneOffset,
} from './gameScene';
import { FACILITY_DEFS } from '../sim/facility/defs';
import { setRoad, setTerrain, setZone } from '../sim/grid';
import { createWorld } from '../sim/world';
import type { VehicleView } from '../sim/traffic';

/** テスト用に最小限の VehicleView を作る（`overrides` で必要なフィールドだけ上書き） */
function makeView(overrides: Partial<VehicleView> & { id: number }): VehicleView {
  return {
    x: 0,
    y: 0,
    angle: 0,
    kind: 'car',
    leg: 'outbound',
    phase: 'road',
    phaseProgress: 0.5,
    edgeProgress: 0.5,
    exitEdge: false,
    entranceEdge: false,
    exitPos: { x: 0, y: 0 },
    entrancePos: { x: 0, y: 0 },
    ...overrides,
  };
}

/**
 * `carRenderState` は車1台ぶんの描画位置・向き・不透明度を求める純関数
 * （実装書 §17 / GPT-5レビュー「車体サイズを常に一定にする」）。
 * T2 でアクセス移動を sim の明示的フェーズへ移したため、描画側の DOOR_FRACTION 補間は
 * 廃止した。車は常に不透明で、建物レイヤの遮蔽によって出現・消失することを確定する。
 *
 * **車線オフセット（左側通行）を足すと、走行中でも座標は VehicleView と完全一致
 * しなくなる。** これは意図した変更なので、以下のテストは「オフセットを除けば
 * 元の座標に一致する」形に書き換えている（車線オフセットの大きさ自体は
 * 下の `describe('車線オフセット')` で別途検証する）。
 */
describe('carRenderState', () => {
  it('走行中（出入り区間でない）は、車線オフセットを除けば VehicleView の座標・向きに一致し、不透明度は1', () => {
    const v = makeView({ id: 1, x: 4.3, y: 7.8, angle: 1.23, edgeProgress: 0.5 });
    const state = carRenderState(v);
    // 座標そのものは一致しない（車線ぶんずれる）が、そのズレは進行方向の法線成分だけ。
    // 進行方向（v.angle）に沿った成分は変化しないはず＝内積がゼロに近い
    const alongDx = Math.cos(v.angle);
    const alongDy = Math.sin(v.angle);
    const alongComponent = (state.x - v.x) * alongDx + (state.y - v.y) * alongDy;
    expect(alongComponent).toBeCloseTo(0, 6);
    expect(state.angle).toBe(v.angle);
    expect(state.opacity).toBe(1);
  });

  it('交差点タイルの中心近くでは、交差点扱いにすると車線オフセットが縮む', () => {
    // タイル(4,7)の中心(4.5,7.5)のすぐそば（距離0.06）に置く。
    // 交差点の弱め半径（実装は0.15タイル）の内側なので、isIntersectionをtrueにすると弱まるはず
    const v = makeView({ id: 1, x: 4.55, y: 7.53, angle: 1.23, edgeProgress: 0.5 });
    const withoutIntersection = carRenderState(v);
    const withIntersectionHere = carRenderState(v, (x, y) => x === 4 && y === 7);
    const distWithout = Math.hypot(withoutIntersection.x - v.x, withoutIntersection.y - v.y);
    const distWith = Math.hypot(withIntersectionHere.x - v.x, withIntersectionHere.y - v.y);
    expect(distWith).toBeLessThan(distWithout);
  });

  it('旧 exitEdge フラグでは位置を補間せず、明示的な road フェーズをそのまま描く', () => {
    const v = makeView({ id: 1, x: 4.3, y: 7.8, angle: 1.23, exitEdge: true });
    const state = carRenderState(v);
    const alongDx = Math.cos(v.angle);
    const alongDy = Math.sin(v.angle);
    const alongComponent = (state.x - v.x) * alongDx + (state.y - v.y) * alongDy;
    expect(alongComponent).toBeCloseTo(0, 6);
    expect(state.opacity).toBe(1);
  });

  it('exiting は sim が返した位置を使い、建物中心でも常に不透明', () => {
    const exitPos = { x: 2, y: 2 };
    const v = makeView({
      id: 1,
      x: 2.5,
      y: 2.5,
      angle: 0,
      phase: 'exiting',
      phaseProgress: 0,
      exitEdge: true,
      exitPos,
    });
    const atStart = carRenderState(v);
    expect(atStart.opacity).toBe(1);
    expect(atStart.x).toBeCloseTo(exitPos.x + 0.5, 6);
    expect(atStart.y).toBeCloseTo(exitPos.y + 0.5, 6);

    const halfway = carRenderState({ ...v, x: 3.5, phaseProgress: 0.5 });
    expect(halfway.opacity).toBe(1);
    expect(halfway.x).toBeCloseTo(3.5, 6);
  });

  it('entering もフェードせず、sim の位置を建物まで滑らかに追う', () => {
    const entrancePos = { x: 5, y: 5 };
    const v = makeView({
      id: 1,
      x: 5.5,
      y: 5.5,
      angle: 0,
      phase: 'entering',
      phaseProgress: 1,
      entranceEdge: true,
      entrancePos,
    });
    const atEnd = carRenderState(v);
    expect(atEnd.opacity).toBe(1);
    expect(atEnd.x).toBeCloseTo(entrancePos.x + 0.5, 6);
    expect(atEnd.y).toBeCloseTo(entrancePos.y + 0.5, 6);
  });
});

describe('pickVehicleAt', () => {
  it('sim 座標ではなく車線オフセット後の描画位置を使う', () => {
    const view = makeView({ id: 7, x: 3.5, y: 4.5, angle: 0 });
    const rendered = carRenderState(view);
    expect(pickVehicleAt([view], { x: rendered.x, y: rendered.y })).toBe(view.id);
    expect(pickVehicleAt([view], { x: rendered.x, y: rendered.y - 0.61 })).toBeNull();
  });

  it('同距離なら id の小さい車を選ぶ', () => {
    const views = [
      makeView({ id: 9, x: 2.5, y: 2.5, angle: 0 }),
      makeView({ id: 3, x: 2.5, y: 2.5, angle: 0 }),
    ];
    const rendered = carRenderState(views[0]!);
    expect(pickVehicleAt(views, rendered)).toBe(3);
  });
});

/**
 * 車線オフセット（左側通行）。GPT-5レビューで確定した「sim には車線を持たせず、
 * 描画だけで進行方向の法線へ車をずらす」方針の検証（M4追加）。
 */
describe('車線オフセット', () => {
  it('幹線は通常道路より太く、id偶奇の2レーンが異なる位置に見える', () => {
    expect(roadRenderWidth(2)).toBeGreaterThan(roadRenderWidth(1));
    expect(vehicleLaneOffset(1, 2)).toBeGreaterThan(vehicleLaneOffset(2, 2));
    expect(vehicleLaneOffset(2, 2)).toBeGreaterThan(vehicleLaneOffset(2, 1));
  });

  it('車線オフセットの大きさは常に指定域（0.10〜0.12タイル）の上限以下に収まる', () => {
    const angles = [0, Math.PI / 6, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 3];
    const progresses = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1];
    for (const angle of angles) {
      for (const edgeProgress of progresses) {
        const v = makeView({ id: 1, x: 10.2, y: 20.7, angle, edgeProgress });
        // isIntersectionをtrueにする場合／しない場合の両方で、常に上限を超えないこと
        for (const isIntersection of [() => false, () => true]) {
          const state = carRenderState(v, isIntersection);
          const dist = Math.hypot(state.x - v.x, state.y - v.y);
          expect(dist).toBeLessThanOrEqual(0.12 + 1e-9);
        }
      }
    }
  });

  it('斜めの辺でも道路中心からの距離が直交の辺と同じになる（正規化の担保）', () => {
    // 直交（東向き, angle=0）と斜め（北東45度, angle=PI/4）の走行中の車を比較する。
    // 法線は angle の cos/sin から作るので、両者とも単位ベクトル×同じ倍率になるはず
    const straight = makeView({ id: 1, x: 3.5, y: 3.5, angle: 0, edgeProgress: 0.5 });
    const diagonal = makeView({ id: 2, x: 3.5, y: 3.5, angle: Math.PI / 4, edgeProgress: 0.5 });

    const straightState = carRenderState(straight);
    const diagonalState = carRenderState(diagonal);

    const straightDist = Math.hypot(straightState.x - straight.x, straightState.y - straight.y);
    const diagonalDist = Math.hypot(diagonalState.x - diagonal.x, diagonalState.y - diagonal.y);

    expect(diagonalDist).toBeCloseTo(straightDist, 9);
  });

  it('進行方向が逆（対向車）だと反対側にオフセットされる（左側通行として車線が分かれる）', () => {
    const forward = makeView({ id: 1, x: 3.5, y: 3.5, angle: 0.7, edgeProgress: 0.5 });
    const backward = makeView({ id: 2, x: 3.5, y: 3.5, angle: 0.7 + Math.PI, edgeProgress: 0.5 });

    const forwardState = carRenderState(forward);
    const backwardState = carRenderState(backward);

    const forwardOffset = { x: forwardState.x - forward.x, y: forwardState.y - forward.y };
    const backwardOffset = { x: backwardState.x - backward.x, y: backwardState.y - backward.y };

    // 反対方向を向いた車の法線オフセットは、正確に反対向きのベクトルになる
    expect(backwardOffset.x).toBeCloseTo(-forwardOffset.x, 9);
    expect(backwardOffset.y).toBeCloseTo(-forwardOffset.y, 9);
    // ゼロベクトルではない（実際にずれている）ことも確認する
    expect(Math.hypot(forwardOffset.x, forwardOffset.y)).toBeGreaterThan(0.05);
  });

  it('建物中心（出発直後・到着直前）では車線オフセットは0になる', () => {
    const exitPos = { x: 2, y: 2 };
    const v = makeView({
      id: 1,
      x: 2.5,
      y: 2.5,
      angle: 0,
      phase: 'exiting',
      phaseProgress: 0,
      exitEdge: true,
      exitPos,
    });
    const state = carRenderState(v);
    // 建物中心ちょうどに一致する（車線オフセットがゼロでないとここがズレる）
    expect(state.x).toBeCloseTo(exitPos.x + 0.5, 9);
    expect(state.y).toBeCloseTo(exitPos.y + 0.5, 9);
  });
});

/**
 * `carDimensions` は車種ごとの大きさを返す純関数。GPT-5レビューが求める
 * 「見えている車は常に一定サイズ」を、状況（走行中／出入り中）を引数に取らない
 * 型そのもので保証する。
 */
describe('carDimensions', () => {
  it('同じ車種なら、出入り区間の有無やedgeProgressに関わらず常に同じ大きさになる', () => {
    const running = carDimensions('car');
    const exiting = carDimensions('car');
    const entering = carDimensions('car');
    expect(exiting).toEqual(running);
    expect(entering).toEqual(running);
  });

  it('トラックは自家用車より大きい（車種ごとのサイズ差は維持する）', () => {
    const car = carDimensions('car');
    const truck = carDimensions('truck');
    expect(truck.length).toBeGreaterThan(car.length);
    expect(truck.width).toBeGreaterThan(car.width);
  });
});

/**
 * `drawIntersectionMarkers` が停止線を描く向きの判定（M5 §4-1）。
 *
 * オーナーのスクリーンショットで、T字路の道路が無い側にも停止線が浮いて見えるバグの
 * 修正。以前は両軸×±1の4本を常に描いていたので、道路が3方向しか無いT字路でも
 * 4本目が浮いていた。ここでは Pixi 描画を介さず、どの (axis, sign) を描くべきかの
 * 純粋な判定だけを検証する（この判定を壊すと、T字路で4本描かれるバグに戻る）。
 */
describe('intersectionStopLineDirections', () => {
  it('十字路（4方向とも道路あり）では4本とも描く', () => {
    const lines = intersectionStopLineDirections({
      east: true,
      west: true,
      south: true,
      north: true,
    });
    expect(lines).toHaveLength(4);
  });

  it('T字路（北側だけ道路が無い）では道路のある3方向にだけ描く', () => {
    const lines = intersectionStopLineDirections({
      east: true,
      west: true,
      south: true,
      north: false,
    });
    expect(lines).toHaveLength(3);
    expect(lines).toContainEqual({ axis: 'horizontal', sign: 1 }); // east
    expect(lines).toContainEqual({ axis: 'horizontal', sign: -1 }); // west
    expect(lines).toContainEqual({ axis: 'vertical', sign: 1 }); // south
    // 道路の無い北（vertical, sign: -1）は出ない
    expect(lines).not.toContainEqual({ axis: 'vertical', sign: -1 });
  });

  it('東側だけ道路が無いT字路でも同様に、東の1本だけが欠ける', () => {
    const lines = intersectionStopLineDirections({
      east: false,
      west: true,
      south: true,
      north: true,
    });
    expect(lines).toHaveLength(3);
    expect(lines).not.toContainEqual({ axis: 'horizontal', sign: 1 });
  });
});

describe('brakeIntensity', () => {
  it('期待どおり進んでいる車は光らない', () => {
    expect(brakeIntensity(0.3, 0.3)).toBe(0);
  });

  it('止まっている車は最大で光る', () => {
    expect(brakeIntensity(0, 0.3)).toBe(1);
  });
});

/**
 * `listBuyableChunks`（`docs/m6-plan.md` §2 W1）。
 * 「解放済みに隣接する未購入チャンク」の一覧が、実際に持っているチャンクの
 * 4近傍から自分自身を除いたものと一致することを確認する。
 */
describe('listBuyableChunks（買える土地の一覧）', () => {
  it('開始チャンク(0,0)だけ持っている場合、隣接する4チャンクが買える土地になる', () => {
    const buyable = listBuyableChunks([{ cx: 0, cy: 0 }]);
    const keys = buyable.map((c) => `${c.cx},${c.cy}`).sort();
    expect(keys).toEqual(['-1,0', '0,-1', '0,1', '1,0']);
  });

  it('既に持っているチャンクは買える土地に含まれない', () => {
    const buyable = listBuyableChunks([
      { cx: 0, cy: 0 },
      { cx: 1, cy: 0 },
    ]);
    expect(buyable.some((c) => c.cx === 0 && c.cy === 0)).toBe(false);
    expect(buyable.some((c) => c.cx === 1 && c.cy === 0)).toBe(false);
  });

  it('2チャンクが共有する隣接チャンクは重複せず1回だけ出る', () => {
    // (0,0) と (1,0) は両方とも (0,1)/(1,1) 等に隣接しうるが、共有する候補は1つにまとまる
    const buyable = listBuyableChunks([
      { cx: 0, cy: 0 },
      { cx: 1, cy: 0 },
    ]);
    const keys = buyable.map((c) => `${c.cx},${c.cy}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('隣接チャンクを1つ購入すると、その先の未購入チャンクが新たに買える土地になる', () => {
    const before = listBuyableChunks([{ cx: 0, cy: 0 }]);
    expect(before.some((c) => c.cx === 2 && c.cy === 0)).toBe(false);
    const after = listBuyableChunks([
      { cx: 0, cy: 0 },
      { cx: 1, cy: 0 },
    ]);
    expect(after.some((c) => c.cx === 2 && c.cy === 0)).toBe(true);
  });
});

/**
 * 施設ツールの設置プレビュー（`docs/m6-plan.md` §2 W4）。
 * footprint と効果範囲（チェビシェフ距離＝正方形）が正しく出ることを確認する。
 */
describe('facilityFootprintTiles / facilityRadiusBounds（施設プレビューの半径）', () => {
  it('footprint=1 は置いたタイル1枚だけ', () => {
    expect(facilityFootprintTiles({ x: 5, y: 7 }, 1)).toEqual([{ x: 5, y: 7 }]);
  });

  it('footprint=4 は pos を左上とした2x2', () => {
    const tiles = facilityFootprintTiles({ x: 5, y: 7 }, 4);
    const keys = tiles.map((t) => `${t.x},${t.y}`).sort();
    expect(keys).toEqual(['5,7', '5,8', '6,7', '6,8']);
  });

  it('footprint=1・radius=5 の効果範囲は中心タイルから5マス四方（チェビシェフ距離）', () => {
    const bounds = facilityRadiusBounds({ x: 10, y: 10 }, 1, 5);
    expect(bounds).toEqual({ x0: 5, y0: 5, x1: 15, y1: 15 });
    // 一辺のマス数は 2*radius+1（中心タイル1枚 + 両側5マスずつ）
    expect(bounds.x1 - bounds.x0 + 1).toBe(11);
    expect(bounds.y1 - bounds.y0 + 1).toBe(11);
  });

  it('footprint=4・radius=2 の効果範囲は2x2の外側をそれぞれ2マス広げた矩形', () => {
    const bounds = facilityRadiusBounds({ x: 0, y: 0 }, 4, 2);
    // 2x2 は [0,1]x[0,1]。そこから外側へ2マスずつ広げると [-2,3]x[-2,3]
    expect(bounds).toEqual({ x0: -2, y0: -2, x1: 3, y1: 3 });
  });
});

describe('facilityPlacementValid（設置プレビューの可否・ベストエフォート判定）', () => {
  const park = FACILITY_DEFS.find((d) => d.id === 'park')!;
  const school = FACILITY_DEFS.find((d) => d.id === 'school')!;
  const SEED = 20260729;

  function freshWorld() {
    const world = createWorld(SEED);
    // 判定を地形の運に左右されないようにする（procedural mapの実際の地形を当てにしない）
    setTerrain(world.state.grid, 10, 10, 'plain');
    return world;
  }

  it('平地・何もない場所で、解放済み(公園)かつ資金があれば置ける', () => {
    const world = freshWorld();
    expect(facilityPlacementValid(world.state, park, { x: 10, y: 10 })).toBe(true);
  });

  it('水面には置けない', () => {
    const world = freshWorld();
    setTerrain(world.state.grid, 10, 10, 'water');
    expect(facilityPlacementValid(world.state, park, { x: 10, y: 10 })).toBe(false);
  });

  it('道路の上には置けない', () => {
    const world = freshWorld();
    setRoad(world.state.grid, 10, 10, true);
    expect(facilityPlacementValid(world.state, park, { x: 10, y: 10 })).toBe(false);
  });

  it('区画済みのタイルには置けない', () => {
    const world = freshWorld();
    setZone(world.state.grid, 10, 10, 'residential');
    expect(facilityPlacementValid(world.state, park, { x: 10, y: 10 })).toBe(false);
  });

  it('資金が足りないと置けない（学校は解放済みでも資金不足なら不可）', () => {
    const world = freshWorld();
    world.state.progress.achievedMilestones = ['pop100']; // 学校の解放条件
    world.state.money = school.cost - 1;
    expect(facilityPlacementValid(world.state, school, { x: 10, y: 10 })).toBe(false);
  });

  it('マイルストーン未達成の施設（学校）は資金があってもロックで置けない', () => {
    const world = freshWorld();
    world.state.progress.achievedMilestones = [];
    world.state.money = school.cost + 1000;
    expect(facilityPlacementValid(world.state, school, { x: 10, y: 10 })).toBe(false);
  });

  it('解放済み・資金あり・平地なら学校も置ける', () => {
    const world = freshWorld();
    world.state.progress.achievedMilestones = ['pop100'];
    world.state.money = school.cost + 1000;
    expect(facilityPlacementValid(world.state, school, { x: 10, y: 10 })).toBe(true);
  });
});
