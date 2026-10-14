import { describe, it, expect } from 'vitest';
import { ECONOMY, FACILITY, SPACE, UI } from '../balance';
import { addChunk, createGrid, setRoad, setRoadRank, setTerrain } from '../grid';
import type { Building, GameState, TilePos } from '../types';
import type { BuildingStats } from '../pipeline';
import { countRoadTiles, facilityUpkeep, roadUpkeep, settleDay } from './index';

const CS = SPACE.CHUNK_SIZE;

/** 最小限の GameState を手で組む。createWorld は使わない（グリッド生成が絡むため） */
function makeState(overrides: Partial<GameState> = {}): GameState {
  const grid = createGrid();
  addChunk(grid, 0, 0, new Uint8Array(CS * CS));

  return {
    seed: 1,
    rngState: 1,
    tick: 600, // ちょうど day=1 の境目
    money: ECONOMY.START_MONEY,
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
    ...overrides,
  };
}

let nextBuildingId = 1;

function building(partial: Partial<Building>): Building {
  return {
    id: nextBuildingId++,
    pos: { x: 0, y: 0 },
    zone: 'residential',
    level: 1,
    occupied: true,
    satisfaction: 50,
    lowSatisfactionDays: 0,
    tripsOkToday: 0,
    tripsFailToday: 0,
    ...partial,
  };
}

/** stats は税収計算に使わない（settleDay が state.buildings を数え直す）ので population だけ埋めればよい */
function stats(population: number): BuildingStats {
  return {
    occupied: { residential: 0, commercial: 0, industrial: 0 },
    built: { residential: 0, commercial: 0, industrial: 0 },
    population,
    recentTripFailRate: 0,
  };
}

function placeRoad(state: GameState, tiles: TilePos[]): void {
  for (const t of tiles) setRoad(state.grid, t.x, t.y, true);
}

describe('economy: 税収', () => {
  it('住・商・工それぞれの棟数×単価が内訳に入る', () => {
    const state = makeState({
      buildings: [
        building({ zone: 'residential' }),
        building({ zone: 'residential' }),
        building({ zone: 'commercial', stock: 100 }),
        building({ zone: 'industrial', output: 0 }),
      ],
    });

    settleDay(state, stats(16));

    const report = state.progress.lastDayReport;
    expect(report).not.toBeNull();
    expect(report?.taxR).toBeCloseTo(2 * ECONOMY.TAX_RESIDENTIAL);
    expect(report?.taxC).toBeCloseTo(1 * ECONOMY.TAX_COMMERCIAL);
    expect(report?.taxI).toBeCloseTo(1 * ECONOMY.TAX_INDUSTRIAL);
  });

  it('未入居の建物からは税収が入らない', () => {
    const state = makeState({
      buildings: [
        building({ zone: 'residential', occupied: false }),
        building({ zone: 'commercial', occupied: false, stock: 100 }),
        building({ zone: 'industrial', occupied: false }),
      ],
    });

    settleDay(state, stats(0));

    const report = state.progress.lastDayReport;
    expect(report?.taxR).toBe(0);
    expect(report?.taxC).toBe(0);
    expect(report?.taxI).toBe(0);
  });

  it('commercial は stock === 0 の日は半額になる', () => {
    const state = makeState({
      buildings: [
        building({ zone: 'commercial', stock: 0 }),
        building({ zone: 'commercial', stock: 40 }),
      ],
    });

    settleDay(state, stats(0));

    const report = state.progress.lastDayReport;
    expect(report?.taxC).toBeCloseTo(ECONOMY.TAX_COMMERCIAL / 2 + ECONOMY.TAX_COMMERCIAL);
  });
});

describe('economy: 道路維持費', () => {
  it('countRoadTiles が道路タイル数を返す', () => {
    const state = makeState({});
    placeRoad(state, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
    expect(countRoadTiles(state)).toBe(3);
  });

  it('道路維持費が道路タイル数に比例する', () => {
    const stateFew = makeState({});
    placeRoad(stateFew, [{ x: 0, y: 0 }]);
    settleDay(stateFew, stats(0));
    const upkeepFew = stateFew.progress.lastDayReport?.upkeepRoad ?? -1;

    const stateMany = makeState({});
    placeRoad(stateMany, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
    settleDay(stateMany, stats(0));
    const upkeepMany = stateMany.progress.lastDayReport?.upkeepRoad ?? -1;

    expect(upkeepFew).toBeCloseTo(1 * ECONOMY.UPKEEP_ROAD_PER_DAY);
    expect(upkeepMany).toBeCloseTo(4 * ECONOMY.UPKEEP_ROAD_PER_DAY);
  });

  it('幹線と橋は通常道路より明確に高く、幹線橋は両方を合算する', () => {
    const state = makeState({});
    setRoad(state.grid, 0, 0, true);
    setRoadRank(state.grid, 1, 0, 2);
    setTerrain(state.grid, 2, 0, 'water');
    setRoad(state.grid, 2, 0, true);
    setTerrain(state.grid, 3, 0, 'water');
    setRoadRank(state.grid, 3, 0, 2);

    const normal = ECONOMY.UPKEEP_ROAD_PER_DAY;
    const arterial = ECONOMY.UPKEEP_ARTERIAL_PER_DAY;
    const bridge = normal + ECONOMY.UPKEEP_BRIDGE_SURCHARGE_PER_DAY;
    const arterialBridge = arterial + ECONOMY.UPKEEP_BRIDGE_SURCHARGE_PER_DAY;
    expect(arterial).toBeGreaterThan(normal);
    expect(bridge).toBeGreaterThan(normal);
    expect(roadUpkeep(state)).toBeCloseTo(normal + arterial + bridge + arterialBridge);
  });
});

describe('economy: 施設維持費', () => {
  it('facilities が空なら 0 を返す', () => {
    const state = makeState({});
    expect(facilityUpkeep(state)).toBe(0);
  });

  it('公園と学校のFacilityDef.upkeepを日次収支へ合算する', () => {
    const state = makeState({
      facilities: [
        { id: 1, defId: 'park', pos: { x: 0, y: 0 } },
        { id: 2, defId: 'school', pos: { x: 1, y: 0 } },
      ],
    });
    const expected = FACILITY.PARK_UPKEEP + FACILITY.SCHOOL_UPKEEP;
    expect(facilityUpkeep(state)).toBe(expected);
    const before = state.money;
    settleDay(state, stats(0));
    expect(state.progress.lastDayReport?.upkeepFacility).toBe(expected);
    expect(state.money).toBe(before - expected);
  });
});

describe('economy: 残高の整合', () => {
  it('内訳の合計と残高の増減が一致する（資金が十分な場合）', () => {
    const state = makeState({
      money: 1000,
      buildings: [
        building({ zone: 'residential' }),
        building({ zone: 'commercial', stock: 100 }),
        building({ zone: 'industrial' }),
      ],
    });
    placeRoad(state, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);

    const moneyBefore = state.money;
    settleDay(state, stats(8));
    const report = state.progress.lastDayReport;
    expect(report).not.toBeNull();
    if (!report) throw new Error('unreachable');

    const expectedDelta =
      report.taxR +
      report.taxC +
      report.taxI -
      report.upkeepRoad -
      report.upkeepFacility +
      report.rewards;
    expect(state.money - moneyBefore).toBeCloseTo(expectedDelta);
  });

  it('残高が負にならない（維持費が資金を超えるケース）', () => {
    const state = makeState({ money: 0.01, buildings: [] });
    // 税収なし・道路だけ大量にある = 維持費が残高を上回る
    const tiles: TilePos[] = [];
    for (let x = 0; x < 32; x++) tiles.push({ x, y: 0 });
    placeRoad(state, tiles);

    settleDay(state, stats(0));

    expect(state.money).toBeGreaterThanOrEqual(0);
    expect(state.money).toBe(0);
  });
});

describe('economy: 日次レポート履歴', () => {
  it('dayReports が UI.REPORT_HISTORY_DAYS 件を超えない', () => {
    const state = makeState({});
    for (let i = 0; i < UI.REPORT_HISTORY_DAYS + 10; i++) {
      state.tick += 600;
      settleDay(state, stats(0));
    }
    expect(state.progress.dayReports.length).toBe(UI.REPORT_HISTORY_DAYS);
    // 直近のものが残っている（古いものから捨てられている）
    const days = state.progress.dayReports.map((r) => r.day);
    expect(days[days.length - 1]).toBe(
      state.progress.dayReports[state.progress.dayReports.length - 1]?.day,
    );
    expect(new Set(days).size).toBe(UI.REPORT_HISTORY_DAYS);
  });
});
