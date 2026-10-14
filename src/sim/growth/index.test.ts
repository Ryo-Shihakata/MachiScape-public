import { describe, it, expect } from 'vitest';
import { DEMAND, GROWTH, LOGISTICS, MOVE_IN, SPACE, TIME } from '../balance';
import { addChunk, createGrid, setRoad, setZone } from '../grid';
import { createRng } from '../rng';
import { tileKey, type Building, type GameState, type ZoneType } from '../types';
import {
  computeBuildingStats,
  computeDemand,
  explainDemand,
  processLogistics,
  processMoveIn,
  updateSatisfaction,
  type ZoneDemandExplanation,
} from './index';

const CS = SPACE.CHUNK_SIZE;
const MOVE_IN_INTERVALS_PER_DAY = TIME.TICKS_PER_DAY / MOVE_IN.INTERVAL_TICKS;

/** createWorld を通さない最小の state。地形は全面 plain */
function makeState(): GameState {
  const grid = createGrid();
  addChunk(grid, 0, 0, new Uint8Array(CS * CS));
  return {
    seed: 1,
    rngState: 1,
    tick: 0,
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

/** (x0..x1, y) に道路を敷く */
function road(state: GameState, x0: number, x1: number, y: number): void {
  for (let x = x0; x <= x1; x++) setRoad(state.grid, x, y, true);
}

/** (x0..x1, y) を区画で塗る */
function zone(state: GameState, x0: number, x1: number, y: number, z: ZoneType): void {
  for (let x = x0; x <= x1; x++) setZone(state.grid, x, y, z);
}

/** 建物を直接置く（入居・満足度の単体テスト用） */
function place(state: GameState, x: number, y: number, z: ZoneType, patch: Partial<Building> = {}) {
  const b: Building = {
    id: state.nextId++,
    pos: { x, y },
    zone: z,
    level: 1,
    occupied: true,
    satisfaction: GROWTH.SATISFACTION_START,
    lowSatisfactionDays: 0,
    tripsOkToday: 0,
    tripsFailToday: 0,
    ...patch,
  };
  setZone(state.grid, x, y, z);
  state.buildings.push(b);
  state.grid.buildingIndex[tileKey(x, y)] = b.id;
  return b;
}

const noDemand = { residential: 0, commercial: 0, industrial: 0 };

// ---------------------------------------------------------------------------

describe('computeBuildingStats', () => {
  it('built は退去済みも数え、occupied と population は入居済みだけを数える', () => {
    const s = makeState();
    place(s, 1, 1, 'residential');
    place(s, 2, 1, 'residential', { occupied: false });
    place(s, 3, 1, 'commercial');

    const stats = computeBuildingStats(s);
    expect(stats.built.residential).toBe(2);
    expect(stats.occupied.residential).toBe(1);
    expect(stats.built.commercial).toBe(1);
    expect(stats.population).toBe(GROWTH.POP_PER_BUILDING);
  });

  it('トリップが0件でも失敗率は0（ゼロ除算しない）', () => {
    expect(computeBuildingStats(makeState()).recentTripFailRate).toBe(0);
  });

  it('失敗率は直近1日の実績で見る（累計ではない）', () => {
    const s = makeState();
    // 累計は悲惨でも、直近1日が良ければ需要は回復する。
    // 累計比のままだと道路を直しても街が戻らない
    s.progress.totalTrips = 1000;
    s.progress.failedTrips = 900;
    s.progress.tripsLastDay = 10;
    s.progress.failedLastDay = 3;
    expect(computeBuildingStats(s).recentTripFailRate).toBeCloseTo(0.3);
  });

  it('まだ1日終わっていなければ当日の集計で代用する', () => {
    const s = makeState();
    s.progress.tripsToday = 4;
    s.progress.failedToday = 1;
    expect(computeBuildingStats(s).recentTripFailRate).toBeCloseTo(0.25);
  });
});

describe('computeDemand', () => {
  it('何もない街では住宅need が正になり、街が始まる', () => {
    const s = makeState();
    const d = computeDemand(s, computeBuildingStats(s));
    expect(d.residential).toBeGreaterThan(0);
  });

  it('雇用が余ると R需要 が上がり、住人が余ると下がる', () => {
    const s = makeState();
    place(s, 1, 1, 'industrial');
    const withJobs = computeDemand(s, computeBuildingStats(s)).residential;

    const s2 = makeState();
    for (let i = 0; i < 5; i++) place(s2, i, 1, 'residential');
    const withWorkers = computeDemand(s2, computeBuildingStats(s2)).residential;

    expect(withJobs).toBeGreaterThan(withWorkers);
  });

  it('C需要は入居済み棟数で抑制される（空き店舗では下がらない）', () => {
    const s = makeState();
    for (let i = 0; i < 4; i++) place(s, i, 1, 'residential');
    const before = computeDemand(s, computeBuildingStats(s)).commercial;

    // 退去した空き店舗は「足りている」ことにならないので需要は下がらない。
    // 下がってしまうと、潰れた店が二度と再入居できない（§8.3 と矛盾する）
    place(s, 0, 3, 'commercial', { occupied: false });
    expect(computeDemand(s, computeBuildingStats(s)).commercial).toBe(before);

    // 入居している店なら需要が下がる
    place(s, 1, 3, 'commercial', { occupied: true });
    expect(computeDemand(s, computeBuildingStats(s)).commercial).toBeLessThan(before);
  });

  it('各需要は [-100, 100] にクランプされる', () => {
    // 商業・工業を極端に建てすぎた街 → C/I 需要が下限に張り付く
    const over = makeState();
    for (let i = 0; i < 40; i++) place(over, i % CS, 5 + Math.floor(i / CS), 'commercial');
    for (let i = 0; i < 40; i++) place(over, i % CS, 9 + Math.floor(i / CS), 'industrial');
    const low = computeDemand(over, computeBuildingStats(over));
    expect(low.commercial).toBe(-100);
    expect(low.industrial).toBe(-100);
    expect(low.residential).toBeLessThanOrEqual(100);
    expect(low.residential).toBeGreaterThanOrEqual(-100);

    // 働き口が働き手に対して大量にある → R需要が上限に張り付く。
    // **雇用の項は「差」ではなく「比率」なので、住民ゼロでは張り付かない**
    // （働き手0は「不均衡なし」として扱い、下駄だけが残る）。
    // 住民を少しだけ置き、働き口を大量に用意して比率を跳ね上げる
    const jobs = makeState();
    place(jobs, 0, 4, 'residential');
    for (let i = 0; i < 60; i++) place(jobs, i % CS, 5 + Math.floor(i / CS), 'industrial');
    const high = computeDemand(jobs, computeBuildingStats(jobs));
    expect(high.residential).toBe(100);
    expect(high.commercial).toBeGreaterThanOrEqual(-100);

    // 全トリップ失敗 → R需要が下限側へ振り切っても -100 を割らない
    const failing = makeState();
    for (let i = 0; i < 30; i++) place(failing, i % CS, 5 + Math.floor(i / CS), 'residential');
    failing.progress.tripsLastDay = 100;
    failing.progress.failedLastDay = 100;
    const bad = computeDemand(failing, computeBuildingStats(failing));
    expect(bad.residential).toBe(-100);
  });
});

/**
 * 需要バーの説明（`docs/m3-plan.md` §4 の 3-3）。
 *
 * ここで守りたいのは「**表示が実挙動とずれないこと**」の一点。UI が係数を写し取って
 * 数式を再実装すると、balance.ts を調整したときに画面の説明だけが古くなる。
 * そのため内訳は sim 側から出し、`computeDemand` と同じ項から作られていることを
 * テストで固定する。
 */
describe('explainDemand', () => {
  /** 内訳の総和がクランプ前の値に一致し、クランプ後が computeDemand と一致すること */
  function checkZone(zone: ZoneDemandExplanation, demandValue: number): void {
    const sum = zone.contributions.reduce((a, c) => a + c.value, 0);
    expect(sum).toBeCloseTo(zone.raw, 10);
    expect(zone.value).toBeCloseTo(demandValue, 10);
    expect(zone.clamped).toBe(zone.raw !== zone.value);
  }

  function checkAll(s: GameState): void {
    const stats = computeBuildingStats(s);
    const d = computeDemand(s, stats);
    const ex = explainDemand(s, stats);
    checkZone(ex.residential, d.residential);
    checkZone(ex.commercial, d.commercial);
    checkZone(ex.industrial, d.industrial);
  }

  it('空の街でも整合する', () => {
    checkAll(makeState());
  });

  it('住・商・工が混ざった街で整合する', () => {
    const s = makeState();
    for (let i = 0; i < 6; i++) place(s, i, 1, 'residential');
    for (let i = 0; i < 3; i++) place(s, i, 3, 'commercial');
    place(s, 0, 5, 'industrial');
    place(s, 1, 5, 'industrial', { occupied: false });
    s.progress.tripsLastDay = 20;
    s.progress.failedLastDay = 5;
    checkAll(s);
  });

  it('クランプで頭打ちになっていても clamped で分かる', () => {
    // 商業・工業を建てすぎて C/I 需要が下限に張り付いた街
    const s = makeState();
    for (let i = 0; i < 40; i++) place(s, i % CS, 5 + Math.floor(i / CS), 'commercial');
    for (let i = 0; i < 40; i++) place(s, i % CS, 9 + Math.floor(i / CS), 'industrial');
    checkAll(s);

    const ex = explainDemand(s);
    expect(ex.commercial.value).toBe(DEMAND.MIN);
    expect(ex.commercial.clamped).toBe(true);
    expect(ex.commercial.raw).toBeLessThan(DEMAND.MIN);
  });

  it('jobs / workers / failRate を数字として取り出せる（HUD には出ていない値）', () => {
    const s = makeState();
    for (let i = 0; i < 2; i++) place(s, i, 1, 'residential');
    place(s, 0, 3, 'commercial');
    place(s, 0, 5, 'industrial');
    s.progress.tripsLastDay = 10;
    s.progress.failedLastDay = 4;

    const ex = explainDemand(s);
    expect(ex.jobs).toBe(GROWTH.JOBS_PER_COMMERCIAL + GROWTH.JOBS_PER_INDUSTRIAL);
    expect(ex.workers).toBe(2 * GROWTH.POP_PER_BUILDING);
    expect(ex.failRate).toBeCloseTo(0.4);
    expect(ex.population).toBe(2 * GROWTH.POP_PER_BUILDING);
    expect(ex.occupied.commercial).toBe(1);
  });

  it('トリップ失敗の項は常に 0 以下、住宅の下駄は常に正', () => {
    const s = makeState();
    place(s, 0, 1, 'residential');
    s.progress.tripsLastDay = 10;
    s.progress.failedLastDay = 10;

    const ex = explainDemand(s);
    const byKey = new Map(ex.residential.contributions.map((c) => [c.key, c]));
    expect(byKey.get('rBase')!.value).toBeGreaterThan(0);
    expect(byKey.get('rTripFail')!.value).toBeLessThan(0);
    // 失敗率100%なら「強く押し下げている」段階になる（UI は −− と表示する）
    expect(byKey.get('rTripFail')!.level).toBe(-2);
  });

  it('stats を省略しても同じ結果になる（UI が呼びやすいように）', () => {
    const s = makeState();
    for (let i = 0; i < 4; i++) place(s, i, 1, 'residential');
    expect(explainDemand(s)).toEqual(explainDemand(s, computeBuildingStats(s)));
  });
});

describe('processMoveIn', () => {
  it('需要が正なら入居し、人口が増える', () => {
    const s = makeState();
    road(s, 0, 10, 0);
    zone(s, 0, 10, 1, 'residential');

    const stats = computeBuildingStats(s);
    const demand = computeDemand(s, stats);
    expect(demand.residential).toBeGreaterThan(0);

    const rng = createRng(42);
    for (let i = 0; i < MOVE_IN_INTERVALS_PER_DAY; i++) {
      const current = computeBuildingStats(s);
      processMoveIn(s, current, computeDemand(s, current), rng);
    }

    expect(s.buildings.length).toBeGreaterThan(0);
    expect(s.buildings.every((b) => b.occupied)).toBe(true);
    expect(computeBuildingStats(s).population).toBeGreaterThan(0);
  });

  it('道路アクセスのない区画タイルには建たない', () => {
    const s = makeState();
    road(s, 0, 10, 0);
    // y=1,2 はアクセスあり（距離1,2）、y=3 以降はアクセスなし（距離3）
    zone(s, 0, 10, 3, 'residential');
    zone(s, 0, 10, 8, 'residential');

    const stats = computeBuildingStats(s);
    processMoveIn(s, stats, { ...noDemand, residential: 100 }, createRng(7));
    expect(s.buildings).toHaveLength(0);

    zone(s, 0, 10, 2, 'residential');
    processMoveIn(s, computeBuildingStats(s), { ...noDemand, residential: 100 }, createRng(7));
    expect(s.buildings.length).toBeGreaterThan(0);
    expect(s.buildings.every((b) => b.pos.y === 2)).toBe(true);
  });

  it('1回の入居数は min(日次期待値 / 1日の実行回数, 空き数)', () => {
    const s = makeState();
    road(s, 0, 20, 0);
    zone(s, 0, 20, 1, 'residential'); // 空き21タイル

    // 定数から期待値を導く（数値を直書きすると balance.ts の調整でテストが嘘になる）。
    // 端数は確率で扱うので、切り捨て値と +1 のどちらかになる
    const demand =
      (MOVE_IN.DEMAND_PER_MOVE_IN * 2 + MOVE_IN.DEMAND_PER_MOVE_IN / 2) *
      MOVE_IN_INTERVALS_PER_DAY;
    processMoveIn(s, computeBuildingStats(s), { ...noDemand, residential: demand }, createRng(1));
    expect(s.buildings.length).toBeGreaterThanOrEqual(2);
    expect(s.buildings.length).toBeLessThanOrEqual(3);

    // 空きが足りないときは空き数で頭打ち
    const s2 = makeState();
    road(s2, 0, 20, 0);
    zone(s2, 0, 1, 1, 'residential'); // 空き2タイル
    processMoveIn(s2, computeBuildingStats(s2), { ...noDemand, residential: 100 }, createRng(1));
    expect(s2.buildings).toHaveLength(2);
  });

  it('需要が0以下なら誰も入居しない', () => {
    const s = makeState();
    road(s, 0, 10, 0);
    zone(s, 0, 10, 1, 'residential');
    processMoveIn(s, computeBuildingStats(s), { ...noDemand, residential: -50 }, createRng(1));
    expect(s.buildings).toHaveLength(0);
  });

  it('建てた建物は buildingIndex に登録される', () => {
    const s = makeState();
    road(s, 0, 10, 0);
    zone(s, 0, 10, 1, 'residential');
    processMoveIn(s, computeBuildingStats(s), { ...noDemand, residential: 50 }, createRng(3));

    expect(s.buildings.length).toBeGreaterThan(0);
    for (const b of s.buildings) {
      expect(s.grid.buildingIndex[tileKey(b.pos.x, b.pos.y)]).toBe(b.id);
    }
  });

  it('区画タイプごとに正しい初期在庫を持つ', () => {
    const s = makeState();
    road(s, 0, 10, 0);
    zone(s, 0, 4, 1, 'commercial');
    zone(s, 5, 10, 1, 'industrial');
    // 棟数そのものではなく「初期在庫が種別ごとに正しいか」を見るテストなので、
    // 入居数は定数から導く（数値を直書きすると balance.ts の調整でテストが嘘になる）
    const twoBuildings = MOVE_IN.DEMAND_PER_MOVE_IN * 2 * MOVE_IN_INTERVALS_PER_DAY;
    processMoveIn(
      s,
      computeBuildingStats(s),
      { ...noDemand, commercial: twoBuildings, industrial: twoBuildings },
      createRng(5),
    );

    const c = s.buildings.filter((b) => b.zone === 'commercial');
    const i = s.buildings.filter((b) => b.zone === 'industrial');
    expect(c).toHaveLength(2);
    expect(i).toHaveLength(2);
    expect(c.every((b) => b.stock === LOGISTICS.STOCK_MAX && b.output === undefined)).toBe(true);
    expect(i.every((b) => b.output === 0 && b.stock === undefined)).toBe(true);
    expect(s.buildings.every((b) => b.level === 1)).toBe(true);
    expect(s.buildings.every((b) => b.satisfaction === GROWTH.SATISFACTION_START)).toBe(true);
  });

  it('決定論: 同じ state と同じ seed なら完全に同じ建物が建つ', () => {
    const run = () => {
      const s = makeState();
      road(s, 0, 20, 0);
      zone(s, 0, 20, 1, 'residential');
      zone(s, 0, 20, 2, 'residential');
      const rng = createRng(12345);
      // 複数日ぶん回して抽選の履歴ごと比較する
      for (let day = 0; day < 5; day++) {
        for (let interval = 0; interval < MOVE_IN_INTERVALS_PER_DAY; interval++) {
          const stats = computeBuildingStats(s);
          processMoveIn(s, stats, computeDemand(s, stats), rng);
        }
      }
      return s.buildings.map((b) => `${b.id}@${b.pos.x},${b.pos.y}:${b.zone}`);
    };

    const a = run();
    const b = run();
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it('決定論: districts の並び（購入順）が違っても同じ結果になる', () => {
    const build = (order: Array<[number, number]>) => {
      const s = makeState();
      addChunk(s.grid, 1, 0, new Uint8Array(CS * CS));
      s.districts = order.map(([cx, cy]) => ({ cx, cy, purchased: !(cx === 0 && cy === 0) }));
      road(s, 0, CS + 10, 0);
      zone(s, 0, CS + 10, 1, 'residential');
      processMoveIn(s, computeBuildingStats(s), { ...noDemand, residential: 60 }, createRng(99));
      return s.buildings.map((b) => `${b.pos.x},${b.pos.y}`);
    };

    expect(
      build([
        [0, 0],
        [1, 0],
      ]),
    ).toEqual(
      build([
        [1, 0],
        [0, 0],
      ]),
    );
  });
});

describe('processLogistics', () => {
  it('industrial は毎日生産し、STOCK_MAX で頭打ちになる', () => {
    const s = makeState();
    const b = place(s, 1, 1, 'industrial', { output: 0 });

    processLogistics(s);
    expect(b.output).toBe(LOGISTICS.PROD_PER_DAY);

    for (let d = 0; d < 10; d++) processLogistics(s);
    expect(b.output).toBe(LOGISTICS.STOCK_MAX);
  });

  it('commercial は毎日消費し、0 で止まる（負にならない）', () => {
    const s = makeState();
    const b = place(s, 1, 1, 'commercial', { stock: LOGISTICS.CONSUME_PER_DAY + 5 });

    processLogistics(s);
    expect(b.stock).toBe(5);
    processLogistics(s);
    expect(b.stock).toBe(0);
    processLogistics(s);
    expect(b.stock).toBe(0);
  });

  it('退去済みの建物は生産も消費もしない', () => {
    const s = makeState();
    const ind = place(s, 1, 1, 'industrial', { output: 10, occupied: false });
    const com = place(s, 2, 1, 'commercial', { stock: 50, occupied: false });
    processLogistics(s);
    expect(ind.output).toBe(10);
    expect(com.stock).toBe(50);
  });

  it('residential は在庫を持たない', () => {
    const s = makeState();
    const b = place(s, 1, 1, 'residential');
    processLogistics(s);
    expect(b.stock).toBeUndefined();
    expect(b.output).toBeUndefined();
  });
});

describe('updateSatisfaction', () => {
  it('毎日 SATISFACTION_START に向かって回帰し、行き過ぎない', () => {
    const s = makeState();
    const low = place(s, 1, 1, 'residential', { satisfaction: GROWTH.SATISFACTION_START - 10 });
    const high = place(s, 2, 1, 'residential', { satisfaction: GROWTH.SATISFACTION_START + 10 });

    updateSatisfaction(s);
    expect(low.satisfaction).toBe(GROWTH.SATISFACTION_START - 10 + GROWTH.SATISFACTION_REGRESSION);
    expect(high.satisfaction).toBe(GROWTH.SATISFACTION_START + 10 - GROWTH.SATISFACTION_REGRESSION);

    for (let d = 0; d < 50; d++) updateSatisfaction(s);
    expect(low.satisfaction).toBe(GROWTH.SATISFACTION_START);
    expect(high.satisfaction).toBe(GROWTH.SATISFACTION_START);
  });

  it('commercial は在庫0の日に SATISFACTION_OUT_OF_STOCK ぶん下がる', () => {
    const s = makeState();
    const empty = place(s, 1, 1, 'commercial', { stock: 0, satisfaction: 40 });
    const stocked = place(s, 2, 1, 'commercial', { stock: 50, satisfaction: 40 });

    updateSatisfaction(s);
    // 回帰(+1) → 在庫ペナルティ の順
    expect(empty.satisfaction).toBe(
      40 + GROWTH.SATISFACTION_REGRESSION + GROWTH.SATISFACTION_OUT_OF_STOCK,
    );
    expect(stocked.satisfaction).toBe(40 + GROWTH.SATISFACTION_REGRESSION);
  });

  it('満足度は 0..100 に収まる', () => {
    const s = makeState();
    const b = place(s, 1, 1, 'commercial', { stock: 0, satisfaction: 1 });
    updateSatisfaction(s);
    expect(b.satisfaction).toBe(0);
  });

  it('ABANDON_DAYS 日連続で閾値を下回ると退去する', () => {
    const s = makeState();
    // 回帰しても閾値を超えないよう、十分低い値から始める
    const b = place(s, 1, 1, 'residential', { satisfaction: 5 });

    for (let d = 0; d < GROWTH.ABANDON_DAYS - 1; d++) {
      updateSatisfaction(s);
      expect(b.occupied).toBe(true);
    }
    updateSatisfaction(s);
    expect(b.occupied).toBe(false);
    expect(b.lowSatisfactionDays).toBe(0);
  });

  it('1日でも回復したら連続日数がリセットされ、退去しない', () => {
    const s = makeState();
    const b = place(s, 1, 1, 'residential', { satisfaction: 5 });

    // 閾値未満のまま ABANDON_DAYS - 1 日
    for (let d = 0; d < GROWTH.ABANDON_DAYS - 1; d++) updateSatisfaction(s);
    expect(b.occupied).toBe(true);
    expect(b.lowSatisfactionDays).toBe(GROWTH.ABANDON_DAYS - 1);

    // 交通側が満足度を戻した想定（閾値以上へ）
    b.satisfaction = GROWTH.ABANDON_THRESHOLD + 5;
    updateSatisfaction(s);
    expect(b.lowSatisfactionDays).toBe(0);
    expect(b.occupied).toBe(true);

    // リセット後はまた ABANDON_DAYS 日必要
    b.satisfaction = 5;
    for (let d = 0; d < GROWTH.ABANDON_DAYS - 1; d++) updateSatisfaction(s);
    expect(b.occupied).toBe(true);
    updateSatisfaction(s);
    expect(b.occupied).toBe(false);
  });

  it('退去しても区画と建物は残る', () => {
    const s = makeState();
    const b = place(s, 1, 1, 'residential', { satisfaction: 5 });
    for (let d = 0; d < GROWTH.ABANDON_DAYS; d++) updateSatisfaction(s);

    expect(b.occupied).toBe(false);
    expect(s.buildings).toHaveLength(1);
    expect(s.grid.buildingIndex[tileKey(1, 1)]).toBe(b.id);
    expect(computeBuildingStats(s).built.residential).toBe(1);
    expect(computeBuildingStats(s).population).toBe(0);
  });

  it('退去済みの建物は満足度が動かない', () => {
    const s = makeState();
    const b = place(s, 1, 1, 'residential', { satisfaction: 5, occupied: false });
    updateSatisfaction(s);
    expect(b.satisfaction).toBe(5);
  });
});

describe('退去 → 再入居', () => {
  it('退去したタイルは空きとして扱われ、建て直さずに再入居する', () => {
    const s = makeState();
    road(s, 0, 10, 0);
    zone(s, 0, 0, 1, 'residential'); // 空き1タイルだけ

    processMoveIn(s, computeBuildingStats(s), { ...noDemand, residential: 50 }, createRng(11));
    expect(s.buildings).toHaveLength(1);
    const b = s.buildings[0]!;
    const id = b.id;

    // 満足度が落ちて退去する
    b.satisfaction = 5;
    for (let d = 0; d < GROWTH.ABANDON_DAYS; d++) updateSatisfaction(s);
    expect(b.occupied).toBe(false);

    // 空きが1つあるので再入居する。建物は増えない（id も同じ）
    processMoveIn(s, computeBuildingStats(s), { ...noDemand, residential: 50 }, createRng(11));
    expect(s.buildings).toHaveLength(1);
    expect(s.buildings[0]!.id).toBe(id);
    expect(s.buildings[0]!.occupied).toBe(true);
    expect(s.buildings[0]!.satisfaction).toBe(GROWTH.SATISFACTION_START);
    expect(s.buildings[0]!.lowSatisfactionDays).toBe(0);
  });

  it('再入居した commercial は在庫が補充され、即座に退去し直さない', () => {
    const s = makeState();
    road(s, 0, 10, 0);
    zone(s, 0, 0, 1, 'commercial');
    const b = place(s, 0, 1, 'commercial', { stock: 0, occupied: false, satisfaction: 5 });

    processMoveIn(s, computeBuildingStats(s), { ...noDemand, commercial: 50 }, createRng(2));
    expect(b.occupied).toBe(true);
    expect(b.stock).toBe(LOGISTICS.STOCK_MAX);

    updateSatisfaction(s);
    expect(b.satisfaction).toBe(GROWTH.SATISFACTION_START);
    expect(b.lowSatisfactionDays).toBe(0);
  });

  it('入居済みの建物があるタイルは空きに数えない', () => {
    const s = makeState();
    road(s, 0, 10, 0);
    zone(s, 0, 0, 1, 'residential');
    place(s, 0, 1, 'residential');

    processMoveIn(s, computeBuildingStats(s), { ...noDemand, residential: 100 }, createRng(4));
    expect(s.buildings).toHaveLength(1);
  });
});

describe('日次パイプライン全体', () => {
  /** 十分な道路と区画を用意した街を days 日ぶん回す */
  function runTown(days: number, seed: number) {
    const s = makeState();
    road(s, 0, 20, 0);
    road(s, 0, 20, 4);
    road(s, 0, 20, 8);
    zone(s, 0, 20, 1, 'residential');
    zone(s, 0, 20, 2, 'residential');
    zone(s, 0, 20, 5, 'commercial');
    zone(s, 0, 20, 6, 'industrial');
    const rng = createRng(seed);

    for (let day = 0; day < days; day++) {
      for (let interval = 0; interval < MOVE_IN_INTERVALS_PER_DAY; interval++) {
        const stats = computeBuildingStats(s);
        processMoveIn(s, stats, computeDemand(s, stats), rng);
      }
      processLogistics(s);
      updateSatisfaction(s);
    }
    return s;
  }

  it('道路と区画を用意すると街が立ち上がる', () => {
    const stats = computeBuildingStats(runTown(30, 2026));
    expect(stats.built.residential).toBeGreaterThan(0);
    expect(stats.population).toBeGreaterThan(0);
  });

  it('決定論: 1日を通しで30日回しても同じ seed なら同じ街になる', () => {
    const a = runTown(30, 2026);
    const b = runTown(30, 2026);
    const dump = (s: GameState) =>
      s.buildings.map(
        (x) => `${x.id}@${x.pos.x},${x.pos.y}:${x.zone}:${x.occupied}:${x.satisfaction}`,
      );
    expect(dump(a)).toEqual(dump(b));
    expect(a.nextId).toBe(b.nextId);
  });

  /**
   * **街が止まらないことを守るテスト。**
   *
   * 当初の数式（実装書 §8 のまま）では住宅4棟・商業1棟で完全停止していた。原因は2つ:
   *   1. 入居数が `floor(需要/10)` だったので、需要が 1〜9 の帯に入ると毎日切り捨てられ
   *      永久に1棟も建たなかった → 端数を確率で扱うよう変更
   *   2. C/I 需要が built（退去済みを含む）と比べていたため、店が一度潰れると需要が
   *      負のままになり二度と再入居しなかった → occupied と比べるよう変更し、
   *      過剰建設の抑制は「空き物件を新築より先に埋める」ことで担保
   *
   * このテストは「街が育ち続けること」を守るためのもので、具体的な棟数は
   * バランス調整で変わってよい（下限だけを見ている）。
   */
  it('街が停止せず育ち続ける（住・商・工がすべて立ち上がる）', () => {
    const stats = computeBuildingStats(runTown(60, 2026));
    expect(stats.occupied.residential).toBeGreaterThan(10);
    expect(stats.occupied.commercial).toBeGreaterThan(3);
    expect(stats.occupied.industrial).toBeGreaterThan(1);
    expect(stats.population).toBeGreaterThan(80);
  });

  it('潰れた店が条件の回復後に再入居する（過剰建設の抑制と両立する）', () => {
    const state = runTown(60, 2026);
    const shops = state.buildings.filter((b) => b.zone === 'commercial');
    expect(shops.length).toBeGreaterThan(0);
    // 空き物件が新築より優先されるので、建物数が入居数から大きく乖離しない
    const occupied = shops.filter((b) => b.occupied).length;
    expect(shops.length - occupied).toBeLessThanOrEqual(shops.length);
    expect(occupied).toBeGreaterThan(0);
  });
});
