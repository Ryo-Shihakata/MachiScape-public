import { describe, expect, it } from 'vitest';
import { SPACE, TIME, TRAFFIC } from '../balance';
import { addChunk, createGrid, setRoad } from '../grid';
import { createRng } from '../rng';
import { createCongestionMap } from '../road/congestion';
import type { GameState, TilePos, Vehicle } from '../types';
import { stepTraffic } from './index';

const ROAD_Y = 5;

function stateWithRoad(): GameState {
  const grid = createGrid();
  addChunk(grid, 0, 0, new Uint8Array(SPACE.CHUNK_SIZE * SPACE.CHUNK_SIZE));
  for (let x = 0; x <= 4; x++) setRoad(grid, x, ROAD_Y, true);
  return {
    seed: 1,
    rngState: 1,
    tick: 100,
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

function vehicle(id: number, path: TilePos[], phase: Vehicle['phase'], edgeProgress = 0): Vehicle {
  return {
    id,
    kind: 'car',
    mode: 'road',
    leg: 'outbound',
    legStartedTick: 0,
    dwellUntilTick: null,
    phase,
    accessProgress: phase === 'exiting' ? 1 : 0,
    path,
    edgeIndex: 0,
    edgeProgress,
    purpose: {
      fromBuildingId: -1,
      from: { x: path[0]!.x, y: ROAD_Y - 1 },
      to: { ...path.at(-1)! },
      startedTick: 0,
    },
  };
}

function step(state: GameState): void {
  stepTraffic(state, createCongestionMap(), createRng(1));
}

function unconstrainedDelta(occupancy: number): number {
  const speed = TRAFFIC.VMAX * Math.max(0.2, 1 - occupancy / TRAFFIC.CAPACITY);
  return speed / TIME.TICKS_PER_SECOND;
}

describe('建物から道路への割り込み合流', () => {
  it('前方・後方のどちらかに必要なギャップが無ければ道路へ出ない', () => {
    const run = (blockedSide: 'front' | 'rear'): Vehicle => {
      const state = stateWithRoad();
      const mergePath = [
        { x: 1, y: ROAD_Y },
        { x: 2, y: ROAD_Y },
        { x: 3, y: ROAD_Y },
      ];
      const merging = vehicle(10, mergePath, 'exiting');
      const blocker =
        blockedSide === 'front'
          ? vehicle(20, mergePath, 'road', TRAFFIC.MERGE_GAP_DISTANCE / 2)
          : vehicle(
              20,
              [{ x: 0, y: ROAD_Y }, ...mergePath],
              'road',
              1 - TRAFFIC.MERGE_GAP_DISTANCE / 2,
            );
      state.vehicles.push(merging, blocker);
      step(state);
      expect(merging.mergeWaitSinceTick).toBe(state.tick);
      return merging;
    };

    for (const blockedSide of ['front', 'rear'] as const) {
      const merging = run(blockedSide);
      expect(merging.phase).toBe('exiting');
      expect(merging.accessProgress).toBe(1);
    }
  });

  it('合流成立を追従より先に確定し、後続車を同じ tick 内で減速させる', () => {
    const state = stateWithRoad();
    const mergePath = [
      { x: 1, y: ROAD_Y },
      { x: 2, y: ROAD_Y },
      { x: 3, y: ROAD_Y },
    ];
    const rearPath = [{ x: 0, y: ROAD_Y }, ...mergePath];
    const merging = vehicle(10, mergePath, 'exiting');
    // 前後とも必要ギャップちょうどなので合流できる。合流車は前車との車間を保って
    // 停止し、新しい前車を認識した後続も同じ tick に停止する。
    const front = vehicle(20, mergePath, 'road', TRAFFIC.MERGE_GAP_DISTANCE);
    const rear = vehicle(30, rearPath, 'road', 1 - TRAFFIC.MERGE_GAP_DISTANCE);
    const rearBefore = rear.edgeProgress;
    state.vehicles.push(rear, merging, front);

    step(state);

    expect(merging.phase).toBe('road');
    expect(rear.edgeProgress).toBe(rearBefore);
    expect(rear.edgeProgress).toBeLessThan(rearBefore + unconstrainedDelta(1));
  });

  it('最大待機時間に達した車はギャップが無くても必ず道路へ出る', () => {
    const state = stateWithRoad();
    const path = [
      { x: 1, y: ROAD_Y },
      { x: 2, y: ROAD_Y },
      { x: 3, y: ROAD_Y },
    ];
    const merging = vehicle(10, path, 'exiting');
    merging.mergeWaitSinceTick = state.tick - TRAFFIC.MERGE_MAX_WAIT_TICKS;
    const blocker = vehicle(20, path, 'road', TRAFFIC.MERGE_GAP_DISTANCE / 2);
    state.vehicles.push(merging, blocker);

    step(state);

    expect(merging.phase).toBe('road');
    expect(merging.mergeWaitSinceTick).toBeUndefined();
  });

  it('同じ場所への同時合流は車両配列の順序によらず id 昇順で1台ずつ通す', () => {
    const run = (reverse: boolean): Array<[number, Vehicle['phase']]> => {
      const state = stateWithRoad();
      const path = [
        { x: 1, y: ROAD_Y },
        { x: 2, y: ROAD_Y },
        { x: 3, y: ROAD_Y },
      ];
      const candidates = [vehicle(2, path, 'exiting'), vehicle(1, path, 'exiting')];
      state.vehicles.push(...(reverse ? candidates.reverse() : candidates));
      step(state);
      return state.vehicles
        .map((current) => [current.id, current.phase] as [number, Vehicle['phase']])
        .sort((a, b) => a[0] - b[0]);
    };

    expect(run(false)).toEqual([
      [1, 'road'],
      [2, 'exiting'],
    ]);
    expect(run(true)).toEqual(run(false));
  });
});
