/**
 * 情報オーバーレイの描画テスト（W3a）。
 *
 * `overlay.ts` は Pixi を型としてしか使わない（`import type`）ので、
 * WebGL 無しの環境でも「どの色をどこに塗ったか」を検証できる。
 * ここで見るのは次の2点:
 *
 * 1. 各モードが**実際に色を出す**こと（描画関数が空振りしていないこと）
 * 2. タイル数に比例して `fill()` が増えないこと（＝色ごとに束ねられていること）。
 *    毎フレーム走る描画なので、この性質が崩れると 60fps が出なくなる
 */

import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import { ROAD } from '../sim/balance';
import { addChunk, hasRoad, hasRoadAccess, setRoad, setRoadRank, setZone } from '../sim/grid';
import { generateChunk } from '../sim/mapgen';
import type { Building, GameState, TilePos, Vehicle } from '../sim/types';
import { createWorld } from '../sim/world';
import type { CongestionMap } from '../sim/road/congestion';
import type { FlowMap } from '../sim/road/flow';
import { overlayDrawFor, type OverlayMode } from './overlay';
import { lightTheme } from './theme';

interface Fill {
  color: number;
  alpha: number;
  /** その fill が一度に塗った矩形の数 */
  shapes: number;
}

interface Stroke {
  color: number;
  alpha: number;
  /** moveTo→lineTo で積んだ頂点数（moveTo ぶんを含む） */
  points: number;
}

/**
 * `Graphics` の代役。rect/roundRect/fill に加え、経路オーバーレイ（M5 §4-4）が使う
 * moveTo/lineTo/stroke と blendMode の書き込みも記録する。
 */
function recorder(): {
  g: Graphics;
  fills: Fill[];
  strokes: Stroke[];
  blendModes: string[];
} {
  const fills: Fill[] = [];
  const strokes: Stroke[] = [];
  const blendModes: string[] = [];
  let pending = 0;
  let points = 0;
  const g: Record<string, unknown> = {
    rect() {
      pending++;
      return g;
    },
    roundRect() {
      pending++;
      return g;
    },
    fill(style: { color: number; alpha: number }) {
      fills.push({ color: style.color, alpha: style.alpha, shapes: pending });
      pending = 0;
      return g;
    },
    moveTo() {
      points = 1;
      return g;
    },
    lineTo() {
      points++;
      return g;
    },
    stroke(style: { color: number; alpha: number }) {
      strokes.push({ color: style.color, alpha: style.alpha, points });
      points = 0;
      return g;
    },
  };
  Object.defineProperty(g, 'blendMode', {
    get: () => blendModes.at(-1) ?? 'normal',
    set: (v: string) => {
      blendModes.push(v);
    },
  });
  return { g: g as unknown as Graphics, fills, strokes, blendModes };
}

function draw(
  mode: OverlayMode,
  state: GameState,
  congestion: CongestionMap = {},
  flow: FlowMap = {},
): Fill[] {
  const fn = overlayDrawFor(mode);
  if (!fn) throw new Error(`${mode} に描画関数が無い`);
  const { g, fills } = recorder();
  fn(g, { state, congestion, flow, theme: lightTheme });
  return fills;
}

/** fill だけでなく stroke・blendMode も見たいテスト（経路オーバーレイ）用 */
function drawDetailed(mode: OverlayMode, state: GameState) {
  const fn = overlayDrawFor(mode);
  if (!fn) throw new Error(`${mode} に描画関数が無い`);
  const rec = recorder();
  fn(rec.g, { state, congestion: {}, flow: {}, theme: lightTheme });
  return rec;
}

/** `sim/traffic/*.test.ts` の同名ヘルパーと同じ最小限の Vehicle を作る */
function vehicle(id: number, path: TilePos[], phase: Vehicle['phase'] = 'road'): Vehicle {
  return {
    id,
    kind: 'car',
    mode: 'road',
    leg: 'outbound',
    legStartedTick: 0,
    dwellUntilTick: null,
    phase,
    accessProgress: 0,
    path,
    edgeIndex: 0,
    edgeProgress: 0,
    purpose: {
      fromBuildingId: -1,
      from: { ...path[0]! },
      to: { ...path.at(-1)! },
      startedTick: 0,
    },
  };
}

function building(id: number, x: number, y: number, patch: Partial<Building> = {}): Building {
  return {
    id,
    pos: { x, y },
    zone: 'residential',
    level: 1,
    occupied: true,
    satisfaction: 50,
    lowSatisfactionDays: 0,
    tripsOkToday: 0,
    tripsFailToday: 0,
    ...patch,
  };
}

describe('overlayDrawFor', () => {
  it("'off' は描画関数を返さない（既定は消灯）", () => {
    expect(overlayDrawFor('off')).toBeNull();
  });

  it('off 以外の全モードに描画関数がある', () => {
    for (const m of [
      'congestion',
      'satisfaction',
      'roadAccess',
      'zone',
      'flow',
      'routes',
    ] as const) {
      expect(overlayDrawFor(m)).toBeTypeOf('function');
    }
  });
});

describe('渋滞オーバーレイ', () => {
  it('道路タイルだけを塗り、混雑度が最大のタイルは警告色になる', () => {
    const world = createWorld(1);
    for (let x = 2; x < 10; x++) setRoad(world.state.grid, x, 5, true);
    const congestion: CongestionMap = { '4,5': 1 };

    const fills = draw('congestion', world.state, congestion);
    const shapes = fills.reduce((n, f) => n + f.shapes, 0);

    // 道路8タイルぶんだけ塗る（区画も建物も無いので他は塗られない）
    expect(shapes).toBe(8);
    expect(fills.some((f) => f.color === lightTheme.previewInvalid)).toBe(true);
    // 混雑ゼロの道は緑（＝流れている）
    expect(fills.some((f) => f.color === lightTheme.residential)).toBe(true);
  });

  it('道路が無ければ何も塗らない', () => {
    const world = createWorld(2);
    expect(draw('congestion', world.state)).toHaveLength(0);
  });

  it('タイル数が増えても fill の回数は色の段数で止まる', () => {
    const world = createWorld(3);
    const congestion: CongestionMap = {};
    // 1チャンクぶんの道路（1024タイル）に少しずつ違う混雑度を与える
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        setRoad(world.state.grid, x, y, true);
        congestion[`${x},${y}`] = ((y * 32 + x) % 100) / 100;
      }
    }
    const fills = draw('congestion', world.state, congestion);
    expect(fills.reduce((n, f) => n + f.shapes, 0)).toBe(32 * 32);
    // 量子化の段数（6）以内に束ねられていること
    expect(fills.length).toBeLessThanOrEqual(6);
  });
});

describe('満足度オーバーレイ', () => {
  it('満足度の低い建物は赤、高い建物は緑になる', () => {
    const world = createWorld(4);
    world.state.buildings = [
      building(1, 3, 3, { satisfaction: 0 }),
      building(2, 4, 3, { satisfaction: 100 }),
    ];
    const fills = draw('satisfaction', world.state);
    expect(fills.some((f) => f.color === lightTheme.previewInvalid)).toBe(true);
    expect(fills.some((f) => f.color === lightTheme.residential)).toBe(true);
  });

  it('平常値（毎日回帰する 50）は警告色にならない', () => {
    // 線形に 0..100 を写すと 50 が琥珀になり、健全な街が一面の警告色に見える。
    // 基準を退去の閾値に置いてあるので 50 は緑側に落ちる
    const world = createWorld(41);
    world.state.buildings = [building(1, 3, 3, { satisfaction: 50 })];
    const fills = draw('satisfaction', world.state);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.color).toBe(lightTheme.residential);
    // 順調なものは薄く塗る（インクの量＝手を打つ必要度）
    expect(fills[0]!.alpha).toBeLessThan(0.5);
  });

  it('退去の閾値ちょうどは警告色（赤）になる', () => {
    const world = createWorld(42);
    world.state.buildings = [building(1, 3, 3, { satisfaction: 30 })];
    expect(draw('satisfaction', world.state)[0]!.color).toBe(lightTheme.previewInvalid);
  });

  it('退去が近い建物は濃く、退去済みは薄く塗る', () => {
    const world = createWorld(5);
    world.state.buildings = [building(1, 3, 3, { satisfaction: 10 })];
    const atRisk = draw('satisfaction', world.state)[0]!;

    world.state.buildings = [building(1, 3, 3, { satisfaction: 10, occupied: false })];
    const vacant = draw('satisfaction', world.state)[0]!;

    expect(atRisk.alpha).toBeGreaterThan(vacant.alpha);
  });

  it('建物が無ければ何も塗らない', () => {
    const world = createWorld(6);
    expect(draw('satisfaction', world.state)).toHaveLength(0);
  });
});

describe('道路アクセスオーバーレイ', () => {
  it('道路が届かない区画を警告色で塗り、届く区画は補助色で塗る', () => {
    const world = createWorld(7);
    const grid = world.state.grid;
    setRoad(grid, 5, 5, true);
    setZone(grid, 5, 6, 'residential'); // 距離1: アクセスあり
    setZone(grid, 20, 20, 'commercial'); // 遠い: アクセスなし

    const fills = draw('roadAccess', world.state);
    const blocked = fills.find((f) => f.color === lightTheme.previewInvalid);
    const ok = fills.find((f) => f.color === lightTheme.preview);

    expect(blocked?.shapes).toBe(1);
    expect(ok?.shapes).toBe(1);
    // 警告のほうが濃い（目に飛び込むべきなのは赤の側）
    expect(blocked!.alpha).toBeGreaterThan(ok!.alpha);
  });

  it('チャンク境界でも sim の判定と一致する', () => {
    // 性能のためチャンク内に収まる判定は自前の近道を通る（overlay.ts の accessInsideChunk）。
    // 近道と sim の hasRoadAccess が食い違うと、境界のタイルだけ誤った色になる。
    // 2チャンクぶんの全区画タイルで両者を突き合わせる
    const world = createWorld(70);
    const grid = world.state.grid;
    addChunk(grid, 1, 0, generateChunk(world.state.seed, 1, 0));
    world.state.districts.push({ cx: 1, cy: 0, purchased: true });

    // 境界（x=31/32）を跨ぐ道路と、その周りをすべて区画で埋める
    for (let y = 0; y < 64; y += 7) {
      for (let x = 24; x < 40; x++) setRoad(grid, x, y, true);
    }
    for (let y = 0; y < 32; y++) {
      for (let x = 24; x < 40; x++) if (!hasRoad(grid, x, y)) setZone(grid, x, y, 'residential');
    }

    const fills = draw('roadAccess', world.state);
    let expectedOk = 0;
    let expectedBlocked = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 24; x < 40; x++) {
        if (hasRoad(grid, x, y)) continue;
        if (hasRoadAccess(grid, x, y, ROAD.ROAD_ACCESS_DISTANCE)) expectedOk++;
        else expectedBlocked++;
      }
    }
    const ok = fills.find((f) => f.color === lightTheme.preview)?.shapes ?? 0;
    const blocked = fills.find((f) => f.color === lightTheme.previewInvalid)?.shapes ?? 0;
    expect(ok).toBe(expectedOk);
    expect(blocked).toBe(expectedBlocked);
    expect(expectedOk).toBeGreaterThan(0);
    expect(expectedBlocked).toBeGreaterThan(0);
  });

  it('区画が無ければ何も塗らない（道路だけでは塗らない）', () => {
    const world = createWorld(8);
    setRoad(world.state.grid, 5, 5, true);
    expect(draw('roadAccess', world.state)).toHaveLength(0);
  });
});

describe('区画オーバーレイ', () => {
  it('区画の種類ごとの色で、通常表示より濃く塗る', () => {
    const world = createWorld(9);
    const grid = world.state.grid;
    setZone(grid, 1, 1, 'residential');
    setZone(grid, 2, 1, 'commercial');
    setZone(grid, 3, 1, 'industrial');

    const fills = draw('zone', world.state);
    expect(fills).toHaveLength(3);
    expect(fills.map((f) => f.color).sort()).toEqual(
      [lightTheme.residential, lightTheme.commercial, lightTheme.industrial].sort(),
    );
    // 通常の区画レイヤ（gameScene.ts の alpha 0.28）より濃いこと
    for (const f of fills) expect(f.alpha).toBeGreaterThan(0.28);
  });
});

describe('流量オーバーレイ（M5 §4-3）', () => {
  it('道路タイルだけを塗り、画面内の最大値で正規化する（通っていないタイルは塗らない）', () => {
    const world = createWorld(50);
    for (let x = 2; x <= 5; x++) setRoad(world.state.grid, x, 5, true);
    // (5,5) は流量マップに無い＝一度も通っていない
    const flow: FlowMap = { '2,5': 1, '3,5': 2, '4,5': 4 };

    const fills = draw('flow', world.state, {}, flow);
    const shapes = fills.reduce((n, f) => n + f.shapes, 0);
    // 4タイルの道路のうち、通過実績がある3タイルだけ塗る
    expect(shapes).toBe(3);
  });

  it('混雑度（congestion）とは別のマップを見る。流量が空でも渋滞が入っていれば何も塗らない', () => {
    const world = createWorld(51);
    setRoad(world.state.grid, 2, 5, true);
    // congestion 側に値を入れても flow が空なら塗らない＝2つの指標が混ざっていない
    const fills = draw('flow', world.state, { '2,5': 1 }, {});
    expect(fills).toHaveLength(0);
  });

  it('誰も走っていなければ何も塗らない（0除算を避ける）', () => {
    const world = createWorld(52);
    setRoad(world.state.grid, 2, 5, true);
    expect(draw('flow', world.state, {}, {})).toHaveLength(0);
  });
});

describe('経路オーバーレイ（M5 §4-4）', () => {
  it('走行中の車の経路を加算合成（blendMode: add）で描く', () => {
    const world = createWorld(60);
    world.state.vehicles = [
      vehicle(1, [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ]),
    ];

    const rec = drawDetailed('routes', world.state);
    expect(rec.strokes.length).toBeGreaterThan(0);
    expect(rec.blendModes).toContain('add');
    // 1台ぶんの alpha は低い（車が増えると線の束になるため。VIS.ROUTE_ALPHA = 0.05）
    for (const s of rec.strokes) expect(s.alpha).toBeLessThan(0.2);
  });

  it('滞在中（dwell）の車は描かない', () => {
    const world = createWorld(61);
    world.state.vehicles = [
      vehicle(
        1,
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        'dwell',
      ),
    ];
    expect(drawDetailed('routes', world.state).strokes).toHaveLength(0);
  });

  it('車がいなければ何も描かない', () => {
    const world = createWorld(62);
    expect(drawDetailed('routes', world.state).strokes).toHaveLength(0);
  });
});

/**
 * 幹線道路（ランク2）がオーバーレイから抜け落ちないこと。
 *
 * `grid.road` は 0/1/2 の3値なのに `=== 1` で道路かどうかを判定していたため、
 * 幹線が混雑・流量・道路アクセスのすべてから丸ごと消えていた
 * （オーナー報告「幹線道路の分析ができるようになっていない」）。
 * **幹線は交通を集めるために引く道なので、最も分析したい対象**。
 */
describe('幹線道路（ランク2）もオーバーレイの対象になる', () => {
  /** 同じ盤面をランク違いで用意し、塗られた矩形の総数を数える */
  function paintedShapes(mode: OverlayMode, rank: 1 | 2): string {
    const w = createWorld(20260729);
    const tiles: TilePos[] = [];
    for (let x = 2; x < 10; x++) tiles.push({ x, y: 5 });
    for (const t of tiles) setRoadRank(w.state.grid, t.x, t.y, rank);

    const congestion: CongestionMap = {};
    const flow: FlowMap = {};
    for (const t of tiles) {
      congestion[`${t.x},${t.y}`] = 0.8;
      flow[`${t.x},${t.y}`] = 5;
    }
    // 道路アクセスは「道路のそばに区画があるか」を見るので、隣に区画を置く
    for (const t of tiles) setZone(w.state.grid, t.x, t.y + 1, 'residential');

    // **色まで含めて比べる。** 塗った矩形の数だけを見ると、道路アクセスは
    // 「アクセスあり」から「アクセスなし」へ色が変わるだけで数が変わらず、
    // バグを取り逃がす（実際に取り逃がした）。
    return draw(mode, w.state, congestion, flow)
      .map((f) => `${f.color.toString(16)}/${f.alpha.toFixed(3)}/${f.shapes}`)
      .sort()
      .join('|');
  }

  for (const mode of ['congestion', 'flow', 'roadAccess'] as const) {
    it(`${mode} は幹線道路を通常道路と同じように扱う`, () => {
      const normal = paintedShapes(mode, 1);
      const arterial = paintedShapes(mode, 2);
      expect(normal).not.toBe('');
      expect(arterial).toBe(normal);
    });
  }
});
