import { describe, expect, it } from 'vitest';
import { GROWTH, SPACE, TIME, TRAFFIC } from '../balance';
import { addChunk, createGrid, setRoad } from '../grid';
import { createRng } from '../rng';
import { createCongestionMap } from '../road/congestion';
import type { Building, GameState, Vehicle, ZoneType } from '../types';
import { stepTraffic, vehicleViews } from './index';
import { spawnPeopleTrips } from './trips';

const CS = SPACE.CHUNK_SIZE;

function stateWithRoad(): GameState {
  const grid = createGrid();
  addChunk(grid, 0, 0, new Uint8Array(CS * CS));
  for (let x = 0; x <= 10; x++) setRoad(grid, x, 5, true);
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
  };
}

function building(state: GameState, zone: ZoneType, x: number): Building {
  const result: Building = {
    id: state.nextId++,
    pos: { x, y: 4 },
    zone,
    level: 1,
    occupied: true,
    satisfaction: GROWTH.SATISFACTION_START,
    lowSatisfactionDays: 0,
    tripsOkToday: 0,
    tripsFailToday: 0,
  };
  state.buildings.push(result);
  return result;
}

function spawnOne(state: GameState): Vehicle {
  const rng = createRng(42);
  for (let i = 0; i < 1000 && state.vehicles.length === 0; i++) {
    spawnPeopleTrips(state, createCongestionMap(), rng, { remaining: 1 });
  }
  const vehicle = state.vehicles[0];
  expect(vehicle).toBeDefined();
  return vehicle!;
}

function tick(state: GameState, count = 1): void {
  const congestion = createCongestionMap();
  const rng = createRng(7);
  for (let i = 0; i < count; i++) {
    state.tick++;
    stepTraffic(state, congestion, rng);
  }
}

describe('往復トリップ', () => {
  it('建物アクセスは実距離を ACCESS_SPEED で進み、道路上より遅い', () => {
    const state = stateWithRoad();
    const path = Array.from({ length: 11 }, (_, x) => ({ x, y: 5 }));
    const purpose = {
      fromBuildingId: -1,
      from: { x: 0, y: 3 }, // アクセス道路まで実距離2タイル
      to: { x: 10, y: 3 },
      startedTick: 0,
    };
    state.vehicles.push(
      {
        id: state.nextId++,
        kind: 'car',
        mode: 'road',
        leg: 'outbound',
        legStartedTick: 0,
        dwellUntilTick: null,
        phase: 'exiting',
        accessProgress: 0,
        path,
        edgeIndex: 0,
        edgeProgress: 0,
        purpose,
      },
      {
        id: state.nextId++,
        kind: 'car',
        mode: 'road',
        leg: 'outbound',
        legStartedTick: 0,
        dwellUntilTick: null,
        phase: 'road',
        accessProgress: 0,
        path,
        edgeIndex: 0,
        edgeProgress: 0,
        purpose,
      },
    );

    tick(state);
    const views = vehicleViews(state);
    const accessView = views.find((v) => v.id === 1)!;
    const roadView = views.find((v) => v.id === 2)!;
    const accessDistance = Math.hypot(accessView.x - 0.5, accessView.y - 3.5);
    const roadDistance = roadView.x - 0.5;

    expect(accessView.phase).toBe('exiting');
    expect(accessDistance).toBeCloseTo(TRAFFIC.ACCESS_SPEED / TIME.TICKS_PER_SECOND, 9);
    expect(roadDistance).toBeCloseTo(
      (TRAFFIC.VMAX * (1 - 1 / TRAFFIC.CAPACITY)) / TIME.TICKS_PER_SECOND,
      9,
    );
    expect(accessDistance).toBeLessThan(roadDistance);
  });

  it('exiting → road → entering → dwell → 復路の exiting → road → entering と遷移する', () => {
    const state = stateWithRoad();
    building(state, 'residential', 0);
    building(state, 'commercial', 10);
    spawnOne(state);
    for (const b of state.buildings) b.occupied = false;

    const phases: string[] = [];
    let previous = '';
    for (let i = 0; i < 500 && state.vehicles.length > 0; i++) {
      const v = state.vehicles[0]!;
      const current = `${v.leg}:${v.phase}`;
      if (current !== previous) {
        phases.push(current);
        previous = current;
      }
      tick(state);
    }

    expect(phases).toEqual([
      'outbound:exiting',
      'outbound:road',
      'outbound:entering',
      'outbound:dwell',
      'return:exiting',
      'return:road',
      'return:entering',
    ]);
    expect(state.vehicles).toHaveLength(0);
  });

  it('往復全体を1トリップとして数え、満足度成功を往路到着時だけ加算する', () => {
    const state = stateWithRoad();
    const home = building(state, 'residential', 0);
    building(state, 'commercial', 10);
    spawnOne(state);
    expect(state.progress.tripsToday).toBe(1);

    // 追加トリップを発生させず、生成済みの1台だけを最後まで進める。
    for (const b of state.buildings) b.occupied = false;
    const before = home.satisfaction;
    tick(state, 500);

    expect(state.vehicles).toHaveLength(0);
    expect(state.progress.tripsToday).toBe(1);
    expect(home.satisfaction).toBe(before + GROWTH.SATISFACTION_TRIP_SUCCESS);
    expect(home.tripsOkToday).toBe(1);
    expect(state.progress.failedToday).toBe(0);
  });

  it('TRIP_TIMEOUT より長い滞在時間はタイムアウトに含めない', () => {
    const state = stateWithRoad();
    const home = building(state, 'residential', 0);
    building(state, 'commercial', 10);
    const vehicle = spawnOne(state);
    for (const b of state.buildings) b.occupied = false;

    vehicle.phase = 'entering';
    vehicle.edgeIndex = vehicle.path.length - 1;
    vehicle.accessProgress = 1;
    tick(state);
    expect(vehicle.dwellUntilTick).not.toBeNull();

    vehicle.dwellUntilTick = state.tick + TRAFFIC.TRIP_TIMEOUT + 10;
    tick(state, TRAFFIC.TRIP_TIMEOUT + 5);

    expect(state.vehicles).toHaveLength(1);
    expect(state.progress.failedToday).toBe(0);
    expect(home.tripsFailToday).toBe(0);
  });
});
