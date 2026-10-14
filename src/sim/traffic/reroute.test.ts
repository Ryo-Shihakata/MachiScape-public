import { describe, expect, it } from 'vitest';
import { ROAD, SPACE } from '../balance';
import { addChunk, createGrid, setRoad } from '../grid';
import { createRng } from '../rng';
import { createCongestionMap, type CongestionMap } from '../road/congestion';
import { findPath } from '../road/pathfind';
import type { GameState, TilePos, Vehicle } from '../types';
import { rerouteStuckVehicles, stepTraffic } from './index';

const CS = SPACE.CHUNK_SIZE;
const ORIGIN = { x: 0, y: 1 };
const DESTINATION = { x: 6, y: 1 };

function directPath(): TilePos[] {
  return Array.from({ length: DESTINATION.x - ORIGIN.x + 1 }, (_, x) => ({
    x,
    y: ORIGIN.y,
  }));
}

/**
 * 上段が直行路、下段が4タイル長い迂回路の小さな道路網。
 *
 *   S-----G
 *    |    |
 *    |    |
 *    +----+
 */
function testState(): GameState {
  const grid = createGrid();
  addChunk(grid, 0, 0, new Uint8Array(CS * CS));
  for (let x = ORIGIN.x; x <= DESTINATION.x; x++) {
    setRoad(grid, x, ORIGIN.y, true);
    if (x >= 1) setRoad(grid, x, 3, true);
  }
  for (let y = ORIGIN.y; y <= 3; y++) {
    setRoad(grid, 1, y, true);
    setRoad(grid, DESTINATION.x, y, true);
  }

  return {
    seed: 1,
    rngState: 1,
    tick:
      Math.ceil((ROAD.TICKS_STUCK + 1) / ROAD.REROUTE_CHECK_INTERVAL_TICKS) *
      ROAD.REROUTE_CHECK_INTERVAL_TICKS,
    money: 1000,
    nextId: 100,
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
  };
}

function vehicle(id: number): Vehicle {
  return {
    id,
    kind: 'car',
    mode: 'road',
    leg: 'outbound',
    legStartedTick: 0,
    dwellUntilTick: null,
    phase: 'road',
    accessProgress: 0,
    path: directPath(),
    edgeIndex: 0,
    edgeProgress: 0,
    purpose: {
      fromBuildingId: -1,
      from: { ...ORIGIN },
      to: { ...DESTINATION },
      startedTick: 0,
    },
  };
}

/**
 * 直行路（上段）だけを一様に混雑させる。
 *
 * **残り経路のタイルを全部混ませること。** 迂回の候補になる条件は
 * 「残り経路の平均混雑度 ≥ REROUTE_CONGESTION_THRESHOLD」なので、一部のタイルだけ
 * 混ませると平均が薄まり、`amount` を上げないと候補にならない。すると今度は
 * 改善率が必ず閾値を超えてしまい、「小さい改善では乗り換えない」ケースを作れなくなる。
 * 全タイルを混ませれば平均 = `amount` になり、混雑度と改善率を独立に動かせる。
 *
 * 現在の辺の終点(x=1)と目的地(x=6)は両経路で共通なので、混ませても比較は歪まない。
 */
function congestDirectRoute(amount: number): CongestionMap {
  const congestion = createCongestionMap();
  for (let x = 1; x <= DESTINATION.x; x++) congestion[`${x},${ORIGIN.y}`] = amount;
  return congestion;
}

function runReroute(state: GameState, congestion: CongestionMap): number {
  return rerouteStuckVehicles(state, congestion, {
    remaining: ROAD.PATHFIND_BUDGET_PER_TICK,
  });
}

describe('弱い動的迂回', () => {
  it('混雑した残り経路から、十分に安い別経路へ移る', () => {
    const state = testState();
    const car = vehicle(10);
    state.vehicles.push(car);

    expect(runReroute(state, congestDirectRoute(1))).toBe(1);
    expect(car.path[0]).toEqual(ORIGIN);
    expect(car.path.at(-1)).toEqual(DESTINATION);
    expect(car.path.some((tile) => tile.y === 3)).toBe(true);
    expect(car.edgeIndex).toBe(0);
    expect(car.edgeProgress).toBe(0);

    state.tick++;
    expect(runReroute(state, congestDirectRoute(1))).toBe(0);
    state.tick += ROAD.REROUTE_CHECK_INTERVAL_TICKS - 1;
    expect(runReroute(state, congestDirectRoute(1))).toBe(0);
  });

  it('新経路が選ばれても改善率が閾値未満なら乗り換えない', () => {
    const state = testState();
    const car = vehicle(10);
    const before = car.path.map((tile) => ({ ...tile }));
    state.vehicles.push(car);

    // 残り経路の平均混雑度 0.6（= 候補になる下限）。直行路 11.0 に対し迂回路 10.2 で
    // 約7%改善。A* は迂回路を返すが、20%の採用閾値には届かない。
    const congestion = congestDirectRoute(0.6);
    const best = findPath(state.grid, congestion, { x: 1, y: ORIGIN.y }, DESTINATION);
    expect(best?.some((tile) => tile.y === 3)).toBe(true);
    expect(runReroute(state, congestion)).toBe(1);
    expect(car.path).toEqual(before);
  });

  it('1回の判定tickに再探索する台数は予算を超えず、idの小さい順になる', () => {
    const state = testState();
    const cars = Array.from({ length: ROAD.REROUTE_BUDGET_PER_TICK + 3 }, (_, i) =>
      vehicle(20 - i),
    );
    state.vehicles.push(...cars);

    expect(runReroute(state, congestDirectRoute(1))).toBe(ROAD.REROUTE_BUDGET_PER_TICK);
    const attemptedIds = cars
      .filter((car) => car.lastRerouteTick === state.tick)
      .map((car) => car.id);
    expect(attemptedIds).toEqual([Math.min(...cars.map((car) => car.id))]);
  });

  it('往路で迂回しても、反転した復路で元の出発地へ戻って往復を完了する', () => {
    const state = testState();
    const car = vehicle(10);
    state.vehicles.push(car);
    expect(runReroute(state, congestDirectRoute(1))).toBe(1);
    expect(car.path[0]).toEqual(ORIGIN);

    const congestion = createCongestionMap();
    const rng = createRng(7);
    let sawReturn = false;
    for (let i = 0; i < 500 && state.vehicles.length > 0; i++) {
      state.tick++;
      stepTraffic(state, congestion, rng);
      const running = state.vehicles[0];
      if (running?.leg === 'return') {
        sawReturn = true;
        expect(running.path.at(-1)).toEqual(ORIGIN);
      }
    }

    expect(sawReturn).toBe(true);
    expect(state.vehicles).toHaveLength(0);
    expect(state.progress.failedTrips).toBe(0);
  });
});
