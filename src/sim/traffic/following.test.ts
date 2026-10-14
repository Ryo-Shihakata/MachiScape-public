import { describe, expect, it } from 'vitest';
import { SPACE, TIME, TRAFFIC } from '../balance';
import { addChunk, createGrid, setRoad, setRoadRank } from '../grid';
import { createRng } from '../rng';
import { createCongestionMap } from '../road/congestion';
import type { GameState, TilePos, Vehicle } from '../types';
import { stepTraffic } from './index';

const ROAD_Y = 5;

function testState(): GameState {
  const grid = createGrid();
  addChunk(grid, 0, 0, new Uint8Array(SPACE.CHUNK_SIZE * SPACE.CHUNK_SIZE));
  for (let x = 0; x <= 3; x++) setRoad(grid, x, ROAD_Y, true);
  return {
    seed: 1,
    rngState: 1,
    tick: 1,
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

function vehicle(id: number, path: TilePos[], edgeProgress: number): Vehicle {
  return {
    id,
    kind: 'car',
    mode: 'road',
    leg: 'outbound',
    legStartedTick: 0,
    dwellUntilTick: null,
    phase: 'road',
    accessProgress: 0,
    path,
    edgeIndex: 0,
    edgeProgress,
    purpose: {
      fromBuildingId: -1,
      from: { ...path[0]! },
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

describe('車の追従', () => {
  it('同じ長さ・同じ流入でも幹線は2レーンで通常道路より多く終端を通過させる', () => {
    const run = (rank: 1 | 2): number => {
      const state = testState();
      if (rank === 2) {
        for (let x = 0; x <= 3; x++) setRoadRank(state.grid, x, ROAD_Y, 2);
      }
      const path = [
        { x: 0, y: ROAD_Y },
        { x: 1, y: ROAD_Y },
        { x: 2, y: ROAD_Y },
      ];
      // 同じ辺の終端直前へ同時に2台流入させる。通常道路ではid順の先頭1台、
      // 幹線では偶奇それぞれのレーンにいる2台とも、このtickに終端を越えられる。
      state.vehicles.push(vehicle(1, path, 0.86), vehicle(2, path, 0.86));
      step(state);
      return state.vehicles.filter((v) => v.edgeIndex > 0).length;
    };

    expect(run(1)).toBe(1);
    expect(run(2)).toBe(2);
  });

  it('前車に追いつく後車を MIN_HEADWAY より先へ進めない', () => {
    const state = testState();
    const path = [
      { x: 0, y: ROAD_Y },
      { x: 1, y: ROAD_Y },
      { x: 2, y: ROAD_Y },
    ];
    // 車間は 0.5 タイル必要なので、初期配置もそれに合わせて離す
    // （0.2 刻みだと最初から車体が重なっている状態になり、
    //  「詰めない」ことの検証にならない）
    const front = vehicle(1, path, 0.9);
    const leader = vehicle(2, path, 0.4);
    const follower = vehicle(3, path, 0);
    state.vehicles.push(follower, leader, front);

    const gapBefore = leader.edgeProgress - follower.edgeProgress;
    step(state);

    // 車間は「辺の進捗の差」ではなく**タイル単位の物理距離**で見るようになった。
    // 進捗0.2 は 0.30〜0.44 タイルの車体より短く、必ず重なっていたため
    // （オーナー報告「車間距離が空いていない」）。ここは直交の辺なので
    // 進捗の差 = タイル距離になる
    // 直交の辺なので「進捗の差」＝「タイル距離」。
    // 追いついた後車は車間ぶんより前へ出ない
    const gapAfter = leader.edgeProgress - follower.edgeProgress;
    // 最初から車間より詰まっている場合は広げられない（後ろへは動けない）ので、
    // 守るべき不変条件は「車間を**さらに**割らない」こと
    expect(gapAfter).toBeGreaterThanOrEqual(
      Math.min(gapBefore, TRAFFIC.MIN_HEADWAY_DISTANCE) - 1e-9,
    );
  });

  it('同じ辺を逆向きに走る対向車では減速しない', () => {
    const state = testState();
    const forward = vehicle(
      1,
      [
        { x: 0, y: ROAD_Y },
        { x: 1, y: ROAD_Y },
      ],
      0.4,
    );
    const reverse = vehicle(
      2,
      [
        { x: 1, y: ROAD_Y },
        { x: 0, y: ROAD_Y },
      ],
      0.6,
    );
    state.vehicles.push(forward, reverse);

    step(state);

    const expected = 0.4 + unconstrainedDelta(1);
    expect(forward.edgeProgress).toBeCloseTo(expected);
    expect(reverse.edgeProgress).toBeCloseTo(0.6 + unconstrainedDelta(1));
  });

  it('同じ有向辺の前方に車がいなければ従来速度で進む', () => {
    const state = testState();
    const lone = vehicle(
      1,
      [
        { x: 0, y: ROAD_Y },
        { x: 1, y: ROAD_Y },
      ],
      0.3,
    );
    state.vehicles.push(lone);

    step(state);

    expect(lone.edgeProgress).toBeCloseTo(0.3 + unconstrainedDelta(1));
  });

  it('同位置の複数車は id でタイブレークされ、繰り返しても同じ結果になる', () => {
    const run = (): Array<[number, number]> => {
      const state = testState();
      const path = [
        { x: 0, y: ROAD_Y },
        { x: 1, y: ROAD_Y },
      ];
      state.vehicles.push(vehicle(3, path, 0.1), vehicle(1, path, 0.1), vehicle(2, path, 0.1));
      step(state);
      return state.vehicles.map((v) => [v.id, v.edgeProgress]);
    };

    const first = run();
    expect(run()).toEqual(first);
    expect(run()).toEqual(first);
    expect(first.find(([id]) => id === 1)?.[1]).toBeGreaterThan(0.1);
    expect(first.find(([id]) => id === 2)?.[1]).toBe(0.1);
    expect(first.find(([id]) => id === 3)?.[1]).toBe(0.1);
  });
});
