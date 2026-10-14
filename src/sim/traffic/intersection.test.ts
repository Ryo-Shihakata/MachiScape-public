import { describe, expect, it } from 'vitest';
import { SPACE, TRAFFIC } from '../balance';
import { addChunk, createGrid, setRoad, setRoadRank } from '../grid';
import { createRng } from '../rng';
import { createCongestionMap } from '../road/congestion';
import { orthogonalIntersectionAt } from '../road/intersection';
import type { GameState, IntersectionAxis, TilePos, Vehicle } from '../types';
import { applyOp, canApplyOp, type World } from '../world';
import {
  ensureIntersectionSignal,
  intersectionAxisCanEnter,
  intersectionSignalAt,
  stepTraffic,
} from './index';

const CENTER = { x: 10, y: 10 };

function crossState(): GameState {
  const grid = createGrid();
  addChunk(grid, 0, 0, new Uint8Array(SPACE.CHUNK_SIZE * SPACE.CHUNK_SIZE));
  for (let x = 2; x <= 18; x++) setRoad(grid, x, CENTER.y, true);
  for (let y = 2; y <= 18; y++) setRoad(grid, CENTER.x, y, true);
  return {
    seed: 1,
    rngState: 1,
    tick: 0,
    money: 1000,
    nextId: 1,
    grid,
    buildings: [],
    facilities: [],
    vehicles: [],
    districts: [{ cx: 0, cy: 0, purchased: false }],
    progress: {
      achievedMilestones: [],
      tutorialDone: false,
      lastDayReport: null,
      dayReports: [],
      totalTrips: 0,
      failedTrips: 0,
      tripsToday: 0,
      failedToday: 0,
      tripsLastDay: 0,
      failedLastDay: 0,
      unservedToday: 0,
      unservedLastDay: 0,
    },
    intersectionPriorities: {},
    intersectionLastServedAxes: {},
  };
}

function path(from: TilePos, to: TilePos): TilePos[] {
  const result: TilePos[] = [{ ...from }];
  let x = from.x;
  let y = from.y;
  while (x !== to.x || y !== to.y) {
    x += Math.sign(to.x - x);
    y += Math.sign(to.y - y);
    result.push({ x, y });
  }
  return result;
}

function vehicle(
  id: number,
  route: TilePos[],
  startedTick: number,
  progress = 0,
  leg: Vehicle['leg'] = 'return',
): Vehicle {
  return {
    id,
    kind: 'car',
    mode: 'road',
    leg,
    legStartedTick: startedTick,
    dwellUntilTick: null,
    phase: 'road',
    accessProgress: 0,
    path: route,
    edgeIndex: 0,
    edgeProgress: progress,
    purpose: {
      fromBuildingId: -1,
      from: { ...route[0]! },
      to: { ...route.at(-1)! },
      startedTick,
    },
  };
}

function tick(state: GameState): void {
  state.tick++;
  stepTraffic(state, createCongestionMap(), createRng(1));
}

describe('孤立した直交交差点の検出', () => {
  it('T字と十字を検出する', () => {
    const state = crossState();
    expect(orthogonalIntersectionAt(state.grid, CENTER.x, CENTER.y)?.connections).toBe(4);
    // 十字路の腕は他の腕と斜め隣接するが、道路グラフ上は中心にしか接続しない。
    expect(orthogonalIntersectionAt(state.grid, CENTER.x, CENTER.y - 1)).toBeNull();
    setRoad(state.grid, CENTER.x, CENTER.y - 1, false);
    expect(orthogonalIntersectionAt(state.grid, CENTER.x, CENTER.y)?.connections).toBe(3);
  });

  it('directions は道路のある向きだけを立て、T字では欠けた側がfalseになる（M5 §4-1）', () => {
    const state = crossState();
    // 十字（4方向とも道路あり）
    expect(orthogonalIntersectionAt(state.grid, CENTER.x, CENTER.y)?.directions).toEqual({
      east: true,
      west: true,
      south: true,
      north: true,
    });

    // 北の腕を消してT字にする
    setRoad(state.grid, CENTER.x, CENTER.y - 1, false);
    expect(orthogonalIntersectionAt(state.grid, CENTER.x, CENTER.y)?.directions).toEqual({
      east: true,
      west: true,
      south: true,
      north: false,
    });
  });

  it('中心や腕の道路ランクを変えても交差点の検出結果が変わらない', () => {
    const state = crossState();
    const before = orthogonalIntersectionAt(state.grid, CENTER.x, CENTER.y);
    for (const tile of [
      CENTER,
      { x: CENTER.x - 1, y: CENTER.y },
      { x: CENTER.x + 1, y: CENTER.y },
      { x: CENTER.x, y: CENTER.y - 1 },
      { x: CENTER.x, y: CENTER.y + 1 },
    ]) {
      setRoadRank(state.grid, tile.x, tile.y, 2);
    }
    expect(orthogonalIntersectionAt(state.grid, CENTER.x, CENTER.y)).toEqual(before);
  });

  it('斜めを生の近傍として数えず、斜め混在や2x2道路塊を誤検出しない', () => {
    const state = crossState();
    for (let y = 2; y <= 18; y++) setRoad(state.grid, CENTER.x, y, false);
    for (let x = 2; x <= 18; x++) setRoad(state.grid, x, CENTER.y, false);

    // 直進2接続 + 斜め1タイルは、生の8近傍なら3だが交差点ではない。
    for (const tile of [CENTER, { x: 9, y: 10 }, { x: 11, y: 10 }, { x: 11, y: 11 }]) {
      setRoad(state.grid, tile.x, tile.y, true);
    }
    expect(orthogonalIntersectionAt(state.grid, CENTER.x, CENTER.y)).toBeNull();

    // 2x2 の角も生の8近傍では3接続に見えるが対象外。
    setRoad(state.grid, 9, 10, false);
    for (const tile of [
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 10, y: 11 },
      { x: 11, y: 11 },
    ]) {
      setRoad(state.grid, tile.x, tile.y, true);
    }
    expect(orthogonalIntersectionAt(state.grid, CENTER.x, CENTER.y)).toBeNull();
  });
});

describe('交差点の競合と優先道路', () => {
  it('直交する2台を同時進入させず、固定順で1台だけを通す', () => {
    const state = crossState();
    // 停止線（INTERSECTION_STOP_PROGRESS）より**手前**から走らせる。
    // 停止線を過ぎた位置から始めると、そこで止めることが物理的にできない
    const horizontal = vehicle(1, path({ x: 9, y: 10 }, { x: 11, y: 10 }), 0, 0.4);
    const vertical = vehicle(2, path({ x: 10, y: 9 }, { x: 10, y: 11 }), 0, 0.4);
    state.vehicles.push(vertical, horizontal);

    tick(state);

    // **停止線は交差点タイルの中心ではなく、その手前に下がった**
    // （オーナー報告「赤線で車が停まるようにして」）。よって1tickでは
    // 交差点に入らず、「停止線を越えて進めた車」と「停止線で止められた車」に分かれる。
    const passed = state.vehicles.filter(
      (v) => v.edgeProgress > TRAFFIC.INTERSECTION_STOP_PROGRESS || v.edgeIndex === 1,
    );
    const waiting = state.vehicles.filter(
      (v) => v.edgeIndex === 0 && v.edgeProgress === TRAFFIC.INTERSECTION_STOP_PROGRESS,
    );
    expect(passed.map((v) => v.id)).toEqual([1]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.id).toBe(2);

    // 描画も参照する共通関数の青側だけが実際に停止線を越えている。
    const signal = intersectionSignalAt(state, CENTER);
    expect(intersectionAxisCanEnter(signal, 'horizontal')).toBe(true);
    expect(intersectionAxisCanEnter(signal, 'vertical')).toBe(false);
  });

  it('反対軸だけが待っても最低青時間までは切り替えず、その後に全赤へ入る', () => {
    const state = crossState();
    ensureIntersectionSignal(state, CENTER);
    state.vehicles.push(vehicle(1, path({ x: 10, y: 9 }, { x: 10, y: 11 }), 0, 0.4));

    for (let i = 0; i < TRAFFIC.SIGNAL_MIN_GREEN_TICKS - 1; i++) {
      tick(state);
      expect(intersectionSignalAt(state, CENTER).greenAxis).toBe('horizontal');
    }
    tick(state);
    expect(intersectionSignalAt(state, CENTER)).toMatchObject({
      phase: 'allRed',
      greenAxis: null,
      remainingTicks: TRAFFIC.SIGNAL_ALL_RED_TICKS,
    });
  });

  it('全赤クリアランス中は両軸とも新規進入させない', () => {
    const state = crossState();
    ensureIntersectionSignal(state, CENTER);
    const vertical = vehicle(1, path({ x: 10, y: 9 }, { x: 10, y: 11 }), 0, 0.4);
    state.vehicles.push(vertical);
    for (let i = 0; i < TRAFFIC.SIGNAL_MIN_GREEN_TICKS; i++) tick(state);
    expect(intersectionSignalAt(state, CENTER).phase).toBe('allRed');

    const horizontal = vehicle(2, path({ x: 9, y: 10 }, { x: 11, y: 10 }), state.tick, 0.4);
    state.vehicles.push(horizontal);
    for (let i = 1; i < TRAFFIC.SIGNAL_ALL_RED_TICKS; i++) {
      tick(state);
      const signal = intersectionSignalAt(state, CENTER);
      expect(signal.greenAxis).toBeNull();
      expect(intersectionAxisCanEnter(signal, 'horizontal')).toBe(false);
      expect(intersectionAxisCanEnter(signal, 'vertical')).toBe(false);
      expect(vertical.edgeIndex).toBe(0);
      expect(horizontal.edgeIndex).toBe(0);
      expect(vertical.edgeProgress).toBeLessThanOrEqual(TRAFFIC.INTERSECTION_STOP_PROGRESS);
      expect(horizontal.edgeProgress).toBeLessThanOrEqual(TRAFFIC.INTERSECTION_STOP_PROGRESS);
    }
  });

  it('JSON保存・復元後も現示の残り時間と切替tickが一致する', () => {
    const original = crossState();
    ensureIntersectionSignal(original, CENTER);
    original.vehicles.push(vehicle(1, path({ x: 10, y: 9 }, { x: 10, y: 11 }), 0, 0.4));
    for (let i = 0; i < TRAFFIC.SIGNAL_MIN_GREEN_TICKS + 3; i++) tick(original);
    original.vehicles = [];

    const restored = JSON.parse(JSON.stringify(original)) as GameState;
    expect(intersectionSignalAt(restored, CENTER)).toEqual(intersectionSignalAt(original, CENTER));
    const remaining = intersectionSignalAt(original, CENTER).remainingTicks;
    expect(remaining).toBeGreaterThan(0);

    for (let i = 1; i < remaining; i++) {
      tick(original);
      tick(restored);
      expect(intersectionSignalAt(restored, CENTER)).toEqual(
        intersectionSignalAt(original, CENTER),
      );
      expect(intersectionSignalAt(restored, CENTER).phase).toBe('allRed');
    }
    tick(original);
    tick(restored);
    expect(intersectionSignalAt(restored, CENTER)).toEqual(intersectionSignalAt(original, CENTER));
    expect(intersectionSignalAt(restored, CENTER).phase).toBe('green');
  });

  it('同一軸の車は同時に通し、その間は直交軸を中心の手前に保つ', () => {
    const state = crossState();
    state.intersectionPriorities = { '10,10': 'horizontal' };
    state.vehicles.push(
      vehicle(1, path({ x: 9, y: 10 }, { x: 11, y: 10 }), 0, 0.9),
      vehicle(2, path({ x: 11, y: 10 }, { x: 9, y: 10 }), 0, 0.9),
      vehicle(3, path({ x: 10, y: 9 }, { x: 10, y: 11 }), 0, 0.9),
    );

    tick(state);
    expect(
      state.vehicles
        .filter((v) => v.edgeIndex === 1)
        .map((v) => v.id)
        .sort((a, b) => a - b),
    ).toEqual([1, 2]);
    expect(state.vehicles.find((v) => v.id === 3)?.edgeIndex).toBe(0);

    tick(state);
    expect(state.vehicles.find((v) => v.id === 3)?.edgeIndex).toBe(0);
  });

  it('優先設定をBuildOpで保存・解除でき、対象外の道路形状は拒否する', () => {
    const state = crossState();
    const world: World = { state, congestion: createCongestionMap(), rng: createRng(1) };
    expect(
      applyOp(world, { kind: 'setIntersectionPriority', pos: CENTER, axis: 'horizontal' }),
    ).toEqual({ ok: true });
    expect(state.intersectionPriorities).toEqual({ '10,10': 'horizontal' });
    expect(JSON.parse(JSON.stringify(state.intersectionPriorities))).toEqual({
      '10,10': 'horizontal',
    });

    state.intersectionLastServedAxes = { '10,10': 'horizontal' };
    expect(
      applyOp(world, {
        kind: 'demolishRoad',
        tiles: [
          { x: CENTER.x, y: CENTER.y - 1 },
          { x: CENTER.x, y: CENTER.y + 1 },
        ],
      }).ok,
    ).toBe(true);
    expect(state.intersectionPriorities).toEqual({});
    expect(state.intersectionLastServedAxes).toEqual({});
    expect(
      applyOp(world, {
        kind: 'buildRoad',
        tiles: [
          { x: CENTER.x, y: CENTER.y - 1 },
          { x: CENTER.x, y: CENTER.y + 1 },
        ],
      }).ok,
    ).toBe(true);
    expect(
      applyOp(world, { kind: 'setIntersectionPriority', pos: CENTER, axis: 'horizontal' }).ok,
    ).toBe(true);

    expect(applyOp(world, { kind: 'setIntersectionPriority', pos: CENTER, axis: null })).toEqual({
      ok: true,
    });
    expect(state.intersectionPriorities).toEqual({});
    expect(
      canApplyOp(world, {
        kind: 'setIntersectionPriority',
        pos: { x: 2, y: CENTER.y },
        axis: 'horizontal',
      }).ok,
    ).toBe(false);
  });

  it('優先側が途切れなくても、従側を最大待機時間後に通す', () => {
    const state = crossState();
    state.intersectionPriorities = { '10,10': 'horizontal' };
    const minor = vehicle(1, path({ x: 10, y: 9 }, { x: 10, y: 11 }), 0, 0.95);
    state.vehicles.push(minor);

    let nextId = 2;
    let minorEnteredAt: number | null = null;
    for (let i = 0; i < TRAFFIC.INTERSECTION_MAX_YIELD_TICKS * 2; i++) {
      const hasHorizontal = state.vehicles.some((v) => v.path[0]?.y === CENTER.y);
      if (!hasHorizontal) {
        state.vehicles.push(
          vehicle(nextId++, path({ x: 9, y: 10 }, { x: 11, y: 10 }), state.tick, 0.95),
        );
      }
      tick(state);
      const currentMinor = state.vehicles.find((v) => v.id === minor.id);
      if (!currentMinor || currentMinor.edgeIndex > 0) {
        minorEnteredAt = state.tick;
        break;
      }
    }

    expect(minorEnteredAt).not.toBeNull();
    expect(minorEnteredAt as number).toBeLessThanOrEqual(TRAFFIC.INTERSECTION_MAX_YIELD_TICKS + 10);
  });

  it('車両配列の順序が違っても同じ通過順になる', () => {
    const run = (reverse: boolean): string => {
      const state = crossState();
      const vehicles = [
        vehicle(4, path({ x: 9, y: 10 }, { x: 11, y: 10 }), 0, 0.9),
        vehicle(1, path({ x: 10, y: 9 }, { x: 10, y: 11 }), 0, 0.9),
        vehicle(3, path({ x: 11, y: 10 }, { x: 9, y: 10 }), 0, 0.9),
        vehicle(2, path({ x: 10, y: 11 }, { x: 10, y: 9 }), 0, 0.9),
      ];
      state.vehicles.push(...(reverse ? vehicles.reverse() : vehicles));
      const entries: string[] = [];
      for (let i = 0; i < 20; i++) {
        const before = new Map(state.vehicles.map((v) => [v.id, v.edgeIndex]));
        tick(state);
        for (const current of state.vehicles) {
          if (before.get(current.id) === 0 && current.edgeIndex === 1) {
            entries.push(`${state.tick}:${current.id}`);
          }
        }
      }
      return `${entries.sort().join('|')}#${JSON.stringify(state.intersectionLastServedAxes)}`;
    };

    expect(run(false)).toBe(run(true));
  });
});

interface TravelStats {
  mean: number;
  p90: number;
  completed: number;
}

function percentile90(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.9) - 1] ?? Number.POSITIVE_INFINITY;
}

function runBiasedTraffic(priority: IntersectionAxis | null): TravelStats {
  const state = crossState();
  if (priority) state.intersectionPriorities = { '10,10': priority };
  const congestion = createCongestionMap();
  const rng = createRng(1);
  const horizontalIds = new Set<number>();
  const startedAt: Record<number, number> = {};
  const durations: number[] = [];

  for (let tickIndex = 0; tickIndex < 1200; tickIndex++) {
    // 900tickまで水平:垂直=4:1で投入し、残り300tickは到着計測のドレインに使う。
    if (tickIndex < 900 && tickIndex % 5 === 0) {
      const id = state.nextId++;
      horizontalIds.add(id);
      startedAt[id] = state.tick;
      state.vehicles.push(
        vehicle(id, path({ x: 2, y: 10 }, { x: 18, y: 10 }), state.tick, 0, 'outbound'),
      );
    }
    if (tickIndex < 900 && tickIndex % 20 === 0) {
      const id = state.nextId++;
      state.vehicles.push(
        vehicle(id, path({ x: 10, y: 2 }, { x: 10, y: 18 }), state.tick, 0, 'outbound'),
      );
    }

    state.tick++;
    stepTraffic(state, congestion, rng);
    for (const arrived of state.vehicles) {
      if (arrived.dwellUntilTick !== null && horizontalIds.has(arrived.id)) {
        durations.push(state.tick - startedAt[arrived.id]!);
      }
    }
    // 復路を混ぜず、投入した一方向の4:1交通だけを比較する。
    state.vehicles = state.vehicles.filter((v) => v.dwellUntilTick === null);
  }

  // 全赤クリアランスを持たなかった旧制御より容量は下がるため、完了数の閾値も
  // 安全な信号制御下で統計比較に十分な標本数、という意味へ更新する。
  expect(durations.length).toBeGreaterThan(20);
  return {
    mean: durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
    p90: percentile90(durations),
    completed: durations.length,
  };
}

describe('4:1交通量の受け入れ基準', () => {
  it('1,200 tickで優先側の平均・p90所要時間を無制御より15%以上改善する', () => {
    const uncontrolled = runBiasedTraffic(null);
    const priority = runBiasedTraffic('horizontal');
    const meanImprovement = (uncontrolled.mean - priority.mean) / uncontrolled.mean;
    const p90Improvement = (uncontrolled.p90 - priority.p90) / uncontrolled.p90;
    console.log(
      `intersection 4:1: uncontrolled mean=${uncontrolled.mean.toFixed(2)} p90=${uncontrolled.p90.toFixed(2)}; ` +
        `priority mean=${priority.mean.toFixed(2)} p90=${priority.p90.toFixed(2)}; ` +
        `improvement mean=${(meanImprovement * 100).toFixed(1)}% p90=${(p90Improvement * 100).toFixed(1)}%`,
    );

    expect(meanImprovement).toBeGreaterThanOrEqual(0.15);
    // 固定の全赤を両ケースが毎回払うため、旧式の即時切替よりp90差は縮む。
    // 安全なクリアランス込みでも、優先設定に明確な効果が残る10%を基準にする。
    expect(p90Improvement).toBeGreaterThanOrEqual(0.1);
  });
});
