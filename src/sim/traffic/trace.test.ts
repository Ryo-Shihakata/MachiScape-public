import { describe, expect, it } from 'vitest';
import { PICK, SPACE } from '../balance';
import { addChunk, createGrid } from '../grid';
import type { Building, GameState, Vehicle, VehiclePhase, ZoneType } from '../types';
import { traceVehicle, tracesForBuilding } from './trace';

const PATH = [
  { x: 2, y: 4 },
  { x: 3, y: 4 },
  { x: 4, y: 4 },
  { x: 5, y: 4 },
];

function emptyState(): GameState {
  const grid = createGrid();
  addChunk(grid, 0, 0, new Uint8Array(SPACE.CHUNK_SIZE ** 2));
  return {
    seed: 1,
    rngState: 1,
    tick: 50,
    money: 0,
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

function addBuilding(state: GameState, id: number, zone: ZoneType, x: number): Building {
  const building: Building = {
    id,
    pos: { x, y: 3 },
    zone,
    level: 1,
    occupied: true,
    satisfaction: 50,
    lowSatisfactionDays: 0,
    tripsOkToday: 0,
    tripsFailToday: 0,
  };
  state.buildings.push(building);
  return building;
}

function vehicle(
  id: number,
  home: Building,
  dest: Building,
  phase: VehiclePhase = 'road',
): Vehicle {
  return {
    id,
    kind: 'car',
    mode: 'road',
    leg: 'outbound',
    legStartedTick: 10,
    dwellUntilTick: null,
    phase,
    accessProgress: 0,
    path: PATH.map((p) => ({ ...p })),
    edgeIndex: 1,
    edgeProgress: 0.25,
    purpose: {
      fromBuildingId: home.id,
      from: { ...home.pos },
      to: { ...dest.pos },
      startedTick: 10,
    },
  };
}

describe('traceVehicle', () => {
  it('往路から復路になっても家と目的地を固定し、leg と反転経路で UI の役割入れ替えを表す', () => {
    const state = emptyState();
    const home = addBuilding(state, 10, 'residential', 1);
    const dest = addBuilding(state, 20, 'commercial', 6);
    const current = vehicle(30, home, dest);
    state.vehicles.push(current);

    expect(traceVehicle(state, current.id)).toMatchObject({
      leg: 'outbound',
      homeBuildingId: home.id,
      homePos: home.pos,
      destPos: dest.pos,
      path: PATH,
    });

    current.leg = 'return';
    current.path.reverse();
    current.legStartedTick = 45;
    expect(traceVehicle(state, current.id)).toMatchObject({
      leg: 'return',
      homeBuildingId: home.id,
      homePos: home.pos,
      destPos: dest.pos,
      path: [...PATH].reverse(),
      elapsedTicks: 5,
    });
  });

  it('車が消えたら null を返す', () => {
    const state = emptyState();
    const home = addBuilding(state, 1, 'residential', 1);
    const dest = addBuilding(state, 2, 'commercial', 6);
    const current = vehicle(3, home, dest);
    state.vehicles.push(current);
    expect(traceVehicle(state, current.id)).not.toBeNull();

    state.vehicles.length = 0;
    expect(traceVehicle(state, current.id)).toBeNull();
  });

  it('phase に応じて残りの道路タイル数を数える', () => {
    const state = emptyState();
    const home = addBuilding(state, 1, 'residential', 1);
    const dest = addBuilding(state, 2, 'commercial', 6);
    const current = vehicle(3, home, dest, 'exiting');
    state.vehicles.push(current);

    expect(traceVehicle(state, current.id)?.remainingTiles).toBe(4);
    current.phase = 'road';
    expect(traceVehicle(state, current.id)?.remainingTiles).toBe(2);
    current.phase = 'entering';
    expect(traceVehicle(state, current.id)?.remainingTiles).toBe(0);
    current.phase = 'dwell';
    expect(traceVehicle(state, current.id)?.remainingTiles).toBe(0);
  });

  it('待機フラグを phase より優先して表示状態へ写す', () => {
    const state = emptyState();
    const home = addBuilding(state, 1, 'residential', 1);
    const dest = addBuilding(state, 2, 'commercial', 6);
    const current = vehicle(3, home, dest, 'road');
    current.intersectionWaitSinceTick = 48;
    state.vehicles.push(current);
    expect(traceVehicle(state, current.id)?.status).toBe('waiting');

    delete current.intersectionWaitSinceTick;
    current.phase = 'exiting';
    current.mergeWaitSinceTick = 49;
    expect(traceVehicle(state, current.id)?.status).toBe('waiting');
  });
});

describe('tracesForBuilding', () => {
  it('出発元・目的地の両方を対象にし、id 順で上限まで返す', () => {
    const state = emptyState();
    const selected = addBuilding(state, 1, 'commercial', 6);
    const other = addBuilding(state, 2, 'residential', 1);
    for (let id = 20; id >= 5; id--) {
      const current = vehicle(id, other, selected);
      state.vehicles.push(current);
    }
    state.vehicles.push(vehicle(100, other, other));

    const traces = tracesForBuilding(state, selected.id, PICK.MAX_TRACES_PER_BUILDING);
    expect(traces).toHaveLength(PICK.MAX_TRACES_PER_BUILDING);
    expect(traces.map((trace) => trace.vehicleId)).toEqual(
      Array.from({ length: PICK.MAX_TRACES_PER_BUILDING }, (_, i) => i + 5),
    );
  });
});
