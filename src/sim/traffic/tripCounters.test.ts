/**
 * 建物ごとの日次カウンタ `tripsOkToday` / `tripsFailToday`（`docs/m3-plan.md` §4 の W3b / 3-2）。
 *
 * これはインスペクタが「満足度がいま上下している理由」を言葉にするための唯一の材料。
 * 満足度の増減は3か所（`applyTripSuccess` / `applyTripFailure` / `timeout`）に分散していて
 * 結果の数値しか残らないので、**加算漏れがあると理由の表示が静かに嘘になる**。
 * だから3か所すべてを個別に押さえる。
 */

import { describe, it, expect } from 'vitest';
import { GROWTH, SPACE, TRAFFIC } from '../balance';
import { addChunk, createGrid, setRoad } from '../grid';
import { createRng } from '../rng';
import { createCongestionMap } from '../road/congestion';
import { updateSatisfaction } from '../growth';
import type { Building, GameState, TilePos, ZoneType } from '../types';
import { stepTraffic } from './index';
import { applyTripFailure, applyTripSuccess, spawnPeopleTrips } from './trips';

const CS = SPACE.CHUNK_SIZE;

function emptyState(): GameState {
  const grid = createGrid();
  addChunk(grid, 0, 0, new Uint8Array(CS * CS));
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

function addBuilding(
  s: GameState,
  zone: ZoneType,
  x: number,
  y: number,
  extra: Partial<Building> = {},
): Building {
  const b: Building = {
    id: s.nextId++,
    pos: { x, y },
    zone,
    level: 1,
    occupied: true,
    satisfaction: GROWTH.SATISFACTION_START,
    lowSatisfactionDays: 0,
    tripsOkToday: 0,
    tripsFailToday: 0,
    ...extra,
  };
  s.buildings.push(b);
  return b;
}

describe('tripsOkToday / tripsFailToday', () => {
  it('到着で tripsOkToday が増える', () => {
    const s = emptyState();
    const b = addBuilding(s, 'residential', 1, 4);

    applyTripSuccess(s, b.id);
    applyTripSuccess(s, b.id);

    expect(b.tripsOkToday).toBe(2);
    expect(b.tripsFailToday).toBe(0);
    // 満足度の増分と回数が対応していること（インスペクタはこの掛け算を見せる）
    expect(b.satisfaction).toBe(GROWTH.SATISFACTION_START + 2 * GROWTH.SATISFACTION_TRIP_SUCCESS);
  });

  it('満足度が 100 で頭打ちでも到着回数は数える（表示が止まらないように）', () => {
    const s = emptyState();
    const b = addBuilding(s, 'residential', 1, 4, { satisfaction: GROWTH.SATISFACTION_MAX });
    applyTripSuccess(s, b.id);
    expect(b.satisfaction).toBe(GROWTH.SATISFACTION_MAX);
    expect(b.tripsOkToday).toBe(1);
  });

  it('経路なしの失敗で tripsFailToday が増える', () => {
    const s = emptyState();
    const b = addBuilding(s, 'residential', 1, 4);

    applyTripFailure(s, b);

    expect(b.tripsFailToday).toBe(1);
    expect(b.tripsOkToday).toBe(0);
    expect(b.satisfaction).toBe(GROWTH.SATISFACTION_START + GROWTH.SATISFACTION_TRIP_FAIL);
  });

  it('タイムアウトでも tripsFailToday が増える（経路なしと同じカウンタ）', () => {
    const s = emptyState();
    for (let x = 0; x < 20; x++) setRoad(s.grid, x, 5, true);
    // 目的地になる商業・工業を置かないので spawnPeopleTrips は車を出さない
    // （pickDestination が null を返して continue する）。計測対象を1台に絞るため
    const home = addBuilding(s, 'residential', 1, 4);

    const path: TilePos[] = [];
    for (let x = 0; x < 20; x++) path.push({ x, y: 5 });
    s.vehicles.push({
      id: s.nextId++,
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
      purpose: {
        fromBuildingId: home.id,
        from: { x: 0, y: 0 },
        to: { x: 19, y: 5 },
        startedTick: 0,
      },
    });
    // 出発から TRIP_TIMEOUT を超えた状態にする
    s.tick = TRAFFIC.TRIP_TIMEOUT + 1;

    stepTraffic(s, createCongestionMap(), createRng(1));

    expect(s.vehicles).toHaveLength(0);
    expect(home.tripsFailToday).toBe(1);
    expect(home.satisfaction).toBe(GROWTH.SATISFACTION_START + GROWTH.SATISFACTION_TRIP_FAIL);
  });

  it('日次でリセットされる（前日の理由を今日の理由として出さない）', () => {
    const s = emptyState();
    const ok = addBuilding(s, 'residential', 1, 4, { tripsOkToday: 3 });
    const bad = addBuilding(s, 'residential', 2, 4, { tripsFailToday: 5 });
    // 退去済みの建物も対象にする。退去直前の失敗が翌日まで残ると理由の表示がずれる
    const gone = addBuilding(s, 'residential', 3, 4, {
      occupied: false,
      tripsOkToday: 1,
      tripsFailToday: 2,
    });

    updateSatisfaction(s);

    expect(ok.tripsOkToday).toBe(0);
    expect(bad.tripsFailToday).toBe(0);
    expect(gone.tripsOkToday).toBe(0);
    expect(gone.tripsFailToday).toBe(0);
  });
});

/**
 * 未処理需要（`docs/m6-plan.md` §2 W2）。
 *
 * 上限で出発できなかった移動を数えないと、渋滞するほど負荷が自動で下がり、
 * 「なぜか成長が止まった」ようにしか見えない。数え方の順序が要点で、
 * **抽選を先に引く**こと（上限で先に弾くと tick 数を数えてしまい約100倍に膨らむ）。
 */
describe('未処理需要', () => {
  it('上限で出発できなかった移動を数え、車は増やさない', () => {
    const s = emptyState();
    for (let x = 0; x < 20; x++) setRoad(s.grid, x, 5, true);
    addBuilding(s, 'residential', 1, 4);
    addBuilding(s, 'commercial', 10, 4);
    const rng = createRng(7);

    // 1台出るまで回す
    for (let i = 0; i < 2000 && s.vehicles.length === 0; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 4 });
    }
    expect(s.vehicles).toHaveLength(1);

    const before = s.progress.unservedToday;
    // 出たまま帰らせずに回すと、抽選に当たっても上限で出せない
    for (let i = 0; i < 3000; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 4 });
    }
    expect(s.progress.unservedToday).toBeGreaterThan(before);
    expect(s.vehicles).toHaveLength(1); // 車は1台のまま
  });

  it('数えるのは「出発するはずだった回数」であって、塞がっていた tick 数ではない', () => {
    const s = emptyState();
    for (let x = 0; x < 20; x++) setRoad(s.grid, x, 5, true);
    addBuilding(s, 'residential', 1, 4);
    addBuilding(s, 'commercial', 10, 4);
    const rng = createRng(8);
    for (let i = 0; i < 2000 && s.vehicles.length === 0; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 4 });
    }

    const ticks = 5000;
    const before = s.progress.unservedToday;
    for (let i = 0; i < ticks; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 4 });
    }
    const counted = s.progress.unservedToday - before;
    // 期待値は ticks × TRIP_RATE_R。tick 数をそのまま数えていれば ticks に近い値になる
    const expected = ticks * TRAFFIC.TRIP_RATE_R;
    expect(counted).toBeGreaterThan(expected * 0.5);
    expect(counted).toBeLessThan(expected * 2);
  });
});
