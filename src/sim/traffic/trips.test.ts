import { describe, it, expect } from 'vitest';
import { FACILITY, GROWTH, LOGISTICS, SPACE, TIME, TRAFFIC } from '../balance';
import { extraTripTargetsAt } from '../facility';
import { addChunk, createGrid, setRoad } from '../grid';
import { createRng } from '../rng';
import { createCongestionMap } from '../road/congestion';
import { tileKey, type Building, type GameState, type ZoneType } from '../types';
import { stepTraffic } from './index';
import {
  accessRoadOf,
  applyTripFailure,
  applyTripSuccess,
  deliverCargo,
  spawnFreightTrips,
  spawnPeopleTrips,
} from './trips';

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
    ...(zone === 'commercial' ? { stock: LOGISTICS.STOCK_MAX } : {}),
    ...(zone === 'industrial' ? { output: 0 } : {}),
    ...extra,
  };
  s.buildings.push(b);
  return b;
}

/** y=5 の行に道路を敷き、その上下に建物を置ける状態にする */
function withRoadRow(s: GameState, y = 5, len = 20): void {
  for (let x = 0; x < len; x++) setRoad(s.grid, x, y, true);
}

/** 指定した商業の building.id 由来の配送時刻へ進めて1tickぶん要求する */
function spawnFreightFor(s: GameState, shop: Building): void {
  s.tick = shop.id % TIME.TICKS_PER_DAY;
  spawnFreightTrips(s, createCongestionMap(), { remaining: 4 });
}

function addSchool(s: GameState, x: number, y: number): number {
  const id = s.nextId++;
  s.facilities.push({ id, defId: 'school', pos: { x, y } });
  s.grid.facilityIndex[tileKey(x, y)] = id;
  return id;
}

describe('accessRoadOf', () => {
  it('最寄りの道路タイルを返す', () => {
    const s = emptyState();
    withRoadRow(s);
    const b = addBuilding(s, 'residential', 3, 4);
    expect(accessRoadOf(s, b)).toEqual({ x: 3, y: 5 });
  });

  it('道路が遠すぎれば null', () => {
    const s = emptyState();
    withRoadRow(s);
    const b = addBuilding(s, 'residential', 3, 20);
    expect(accessRoadOf(s, b)).toBeNull();
  });
});

describe('人の移動', () => {
  it('住宅から商業へ車が出る', () => {
    const s = emptyState();
    withRoadRow(s);
    addBuilding(s, 'residential', 1, 4);
    addBuilding(s, 'commercial', 10, 4);
    const rng = createRng(42);
    // 発生確率が低いので複数tickぶん試す
    for (let i = 0; i < 500 && s.vehicles.length === 0; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 4 });
    }
    expect(s.vehicles.length).toBeGreaterThan(0);
    expect(s.vehicles[0]?.kind).toBe('car');
  });

  it('未入居の住宅からは車が出ない', () => {
    const s = emptyState();
    withRoadRow(s);
    addBuilding(s, 'residential', 1, 4, { occupied: false });
    addBuilding(s, 'commercial', 10, 4);
    const rng = createRng(42);
    for (let i = 0; i < 500; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 4 });
    }
    expect(s.vehicles).toHaveLength(0);
  });

  it('1tickの経路探索予算を超えない', () => {
    const s = emptyState();
    withRoadRow(s);
    for (let i = 0; i < 50; i++) addBuilding(s, 'residential', i % 20, 4);
    addBuilding(s, 'commercial', 10, 6);
    const rng = createRng(1);
    const budget = { remaining: 2 };
    spawnPeopleTrips(s, createCongestionMap(), rng, budget);
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
    expect(s.vehicles.length).toBeLessThanOrEqual(2);
  });
});

describe('学校への追加通学', () => {
  it('通常の外出とは別に学校そのものを目的地とする車が出る', () => {
    const s = emptyState();
    withRoadRow(s);
    const home = addBuilding(s, 'residential', 1, 4);
    const shop = addBuilding(s, 'commercial', 15, 4);
    const schoolPos = { x: 8, y: 4 };
    addSchool(s, schoolPos.x, schoolPos.y);
    const rng = createRng(20260802);
    let schoolTrips = 0;
    let ordinaryTrips = 0;

    for (let i = 0; i < 5000; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 8 });
      expect(s.vehicles.length).toBeLessThanOrEqual(TRAFFIC.MAX_ACTIVE_TRIPS_PER_BUILDING);
      for (const vehicle of s.vehicles) {
        if (vehicle.purpose.to.x === schoolPos.x && vehicle.purpose.to.y === schoolPos.y) {
          schoolTrips++;
        }
        if (vehicle.purpose.to.x === shop.pos.x && vehicle.purpose.to.y === shop.pos.y) {
          ordinaryTrips++;
        }
      }
      // 各抽選を観測するため、完了したものとして次のtickへ進める。
      s.vehicles = [];
    }

    expect(schoolTrips).toBeGreaterThan(0);
    expect(ordinaryTrips).toBeGreaterThan(0);
    expect(s.progress.totalTrips).toBe(schoolTrips + ordinaryTrips);
    expect(home.id).toBeGreaterThan(0);
  });

  it('通学車も到着後に滞在し、同じ経路で住宅へ帰る', () => {
    const s = emptyState();
    withRoadRow(s);
    const home = addBuilding(s, 'residential', 1, 4);
    const schoolPos = { x: 8, y: 4 };
    addSchool(s, schoolPos.x, schoolPos.y);
    const rng = createRng(55);

    for (let i = 0; i < 5000; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 8 });
      const schoolTrip = s.vehicles.find(
        (vehicle) => vehicle.purpose.to.x === schoolPos.x && vehicle.purpose.to.y === schoolPos.y,
      );
      if (schoolTrip) {
        s.vehicles = [schoolTrip];
        break;
      }
      s.vehicles = [];
    }
    expect(s.vehicles).toHaveLength(1);
    home.occupied = false; // 追跡中に新しい車を出さない

    let sawDwell = false;
    let sawReturn = false;
    for (let i = 0; i < 1000 && s.vehicles.length > 0; i++) {
      s.tick++;
      stepTraffic(s, createCongestionMap(), rng);
      const vehicle = s.vehicles[0];
      if (vehicle?.phase === 'dwell') sawDwell = true;
      if (vehicle?.leg === 'return') sawReturn = true;
    }
    expect(sawDwell).toBe(true);
    expect(sawReturn).toBe(true);
    expect(s.vehicles).toHaveLength(0);
  });

  /**
   * **枠は種類ごとに別**（`docs/m6-plan.md` §5 死因2）。
   *
   * 当初は通常外出と枠を共有する実装だったが、住宅はほぼ常に1台出ているので
   * 通学の抽選に当たってもほぼ必ず弾かれ、未処理需要が増えるだけで路上の車が
   * 増えなかった（実測で学校の周辺の通過が+3%）。これでは「置いた瞬間に
   * 流量が変わるのが見える」という受け入れ基準を満たせず、
   * **この施設を入れる意味そのものが消える**。枠を分けて+30%になった。
   */
  it('通常外出が埋まっていても通学は別枠で出せる。ただし通学も1棟1台', () => {
    const s = emptyState();
    withRoadRow(s);
    const home = addBuilding(s, 'residential', 1, 4);
    addBuilding(s, 'commercial', 15, 4);
    addSchool(s, 8, 4);
    s.vehicles.push({
      id: s.nextId++,
      kind: 'car',
      mode: 'road',
      leg: 'outbound',
      legStartedTick: 0,
      dwellUntilTick: null,
      phase: 'road',
      accessProgress: 0,
      path: [
        { x: 1, y: 5 },
        { x: 2, y: 5 },
      ],
      edgeIndex: 0,
      edgeProgress: 0,
      purpose: { fromBuildingId: home.id, from: home.pos, to: { x: 15, y: 4 }, startedTick: 0 },
    });
    const rng = createRng(77);

    for (let i = 0; i < 5000; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 8 });
    }

    // 通常外出の枠は埋まったままなので、増えるのは通学の1台だけ
    expect(s.vehicles).toHaveLength(2);
    const school = s.vehicles.filter((v) => v.purpose.to.x === 8 && v.purpose.to.y === 4);
    expect(school).toHaveLength(TRAFFIC.MAX_ACTIVE_TRIPS_PER_BUILDING);

    // 弾かれたぶんは未処理に数える。通常外出はほぼ全部弾かれ、通学は枠が空いた
    // ときだけ通るので、期待値は通常外出ぶんが下限になる
    const expected = 5000 * TRAFFIC.TRIP_RATE_R;
    expect(s.progress.unservedToday).toBeGreaterThan(expected * 0.5);
  });

  it('同じ種類の学校が重なっても追加確率は累積せず、最寄り1校だけを返す', () => {
    const s = emptyState();
    const near = addSchool(s, 5, 5);
    addSchool(s, 8, 5);

    const targets = extraTripTargetsAt(s, { x: 4, y: 5 });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.facilityId).toBe(near);
    expect(targets[0]?.rate).toBe(FACILITY.SCHOOL_EXTRA_TRIP_RATE);
  });
});

describe('物流', () => {
  it('在庫の減った商業へトラックが出る', () => {
    const s = emptyState();
    withRoadRow(s);
    addBuilding(s, 'industrial', 1, 4, { output: LOGISTICS.STOCK_MAX });
    const shop = addBuilding(s, 'commercial', 10, 4, { stock: 0 });
    spawnFreightFor(s, shop);
    expect(s.vehicles).toHaveLength(1);
    expect(s.vehicles[0]?.kind).toBe('truck');
  });

  it('出庫はトラック生成時に減算され、同じ在庫から二重に払い出さない', () => {
    const s = emptyState();
    withRoadRow(s);
    // 在庫はトラック1台ぶんだけ
    const factory = addBuilding(s, 'industrial', 1, 4, { output: LOGISTICS.TRUCK_LOAD });
    const first = addBuilding(s, 'commercial', 8, 4, { stock: 0 });
    const second = addBuilding(s, 'commercial', 12, 4, { stock: 0 });
    spawnFreightFor(s, first);
    spawnFreightFor(s, second);
    // 2軒が要求するが、在庫は1台ぶんなので払い出しは1回だけ
    expect(s.vehicles).toHaveLength(1);
    expect(factory.output).toBe(0);
  });

  it('在庫が足りない工業からは出荷しない', () => {
    const s = emptyState();
    withRoadRow(s);
    addBuilding(s, 'industrial', 1, 4, { output: LOGISTICS.SUPPLY_MIN_OUTPUT - 1 });
    const shop = addBuilding(s, 'commercial', 10, 4, { stock: 0 });
    spawnFreightFor(s, shop);
    expect(s.vehicles).toHaveLength(0);
  });

  it('在庫が十分な商業は配送を要求しない', () => {
    const s = emptyState();
    withRoadRow(s);
    addBuilding(s, 'industrial', 1, 4, { output: LOGISTICS.STOCK_MAX });
    const shop = addBuilding(s, 'commercial', 10, 4, { stock: LOGISTICS.STOCK_MAX });
    spawnFreightFor(s, shop);
    expect(s.vehicles).toHaveLength(0);
  });

  it('供給元が無いだけでは失敗に数えない（在庫切れのペナルティが担う）', () => {
    const s = emptyState();
    withRoadRow(s);
    const shop = addBuilding(s, 'commercial', 10, 4, { stock: 0 });
    const before = shop.satisfaction;
    spawnFreightFor(s, shop);
    // 工業が無いのは道路網の失敗ではない。ここで罰すると序盤に商業が必ず全滅する
    expect(shop.satisfaction).toBe(before);
    expect(s.progress.failedTrips).toBe(0);
  });

  it('道路が繋がっていなければ失敗に数える', () => {
    const s = emptyState();
    withRoadRow(s, 5, 20);
    // 工場は道路から離れた場所に置き、アクセスできないようにする
    addBuilding(s, 'industrial', 10, 25, { output: LOGISTICS.STOCK_MAX });
    const shop = addBuilding(s, 'commercial', 10, 4, { stock: 0 });
    const before = shop.satisfaction;
    spawnFreightFor(s, shop);
    expect(shop.satisfaction).toBeLessThan(before);
    expect(s.progress.failedTrips).toBe(1);
  });

  it('商業ごとのbuilding.id由来オフセットで1日の中に分散する', () => {
    const s = emptyState();
    withRoadRow(s);
    addBuilding(s, 'industrial', 1, 4, { output: LOGISTICS.STOCK_MAX });
    const first = addBuilding(s, 'commercial', 8, 4, { stock: 0 });
    const second = addBuilding(s, 'commercial', 12, 4, { stock: 0 });

    spawnFreightFor(s, first);
    expect(s.vehicles).toHaveLength(1);
    expect(s.vehicles[0]?.purpose.to).toEqual(first.pos);
    const firstTick = s.vehicles[0]?.purpose.startedTick;

    spawnFreightFor(s, second);
    expect(s.vehicles).toHaveLength(2);
    expect(s.vehicles[1]?.purpose.to).toEqual(second.pos);
    expect(s.vehicles[1]?.purpose.startedTick).not.toBe(firstTick);
  });
});

describe('到着処理', () => {
  it('積荷が商業の在庫に加算される（上限あり）', () => {
    const s = emptyState();
    const shop = addBuilding(s, 'commercial', 10, 4, { stock: 10 });
    deliverCargo(s, {
      id: 1,
      kind: 'truck',
      mode: 'road',
      leg: 'outbound',
      legStartedTick: 0,
      dwellUntilTick: null,
      phase: 'road',
      accessProgress: 0,
      path: [],
      edgeIndex: 0,
      edgeProgress: 0,
      purpose: { fromBuildingId: 99, from: { x: 0, y: 0 }, to: { x: 10, y: 4 }, startedTick: 0 },
    });
    expect(shop.stock).toBe(Math.min(LOGISTICS.STOCK_MAX, 10 + LOGISTICS.TRUCK_LOAD));
  });

  it('満足度は0未満・100超にならない', () => {
    const s = emptyState();
    const b = addBuilding(s, 'residential', 1, 4, { satisfaction: 1 });
    applyTripFailure(s, b);
    expect(b.satisfaction).toBeGreaterThanOrEqual(0);

    b.satisfaction = 100;
    applyTripSuccess(s, b.id);
    expect(b.satisfaction).toBeLessThanOrEqual(100);
  });
});

/**
 * 1棟が同時に出せる車の上限（`TRAFFIC.MAX_ACTIVE_TRIPS_PER_BUILDING`）。
 * 渋滞が渋滞を呼ぶ正のフィードバックを止めるための背圧なので、
 * 「上限に達している間は増えない」「帰ってきたら再び出せる」の両方を守る。
 */
describe('1棟が同時に出せる車の上限', () => {
  function townWithHomes(): GameState {
    const s = emptyState();
    withRoadRow(s);
    for (let x = 1; x <= 4; x++) addBuilding(s, 'residential', x, 4);
    addBuilding(s, 'commercial', 10, 4);
    addBuilding(s, 'commercial', 15, 6);
    return s;
  }

  it('上限に達した住宅からは、何tick回しても新しい車が出ない', () => {
    const s = townWithHomes();
    const rng = createRng(1);
    for (let i = 0; i < 2000; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 8 });
    }
    expect(s.vehicles.length).toBeGreaterThan(0);

    const counts = new Map<number, number>();
    for (const v of s.vehicles) {
      counts.set(v.purpose.fromBuildingId, (counts.get(v.purpose.fromBuildingId) ?? 0) + 1);
    }
    for (const n of counts.values()) {
      expect(n).toBeLessThanOrEqual(TRAFFIC.MAX_ACTIVE_TRIPS_PER_BUILDING);
    }
  });

  it('車が帰り着いた住宅は再び車を出せる', () => {
    const s = townWithHomes();
    const rng = createRng(2);
    for (let i = 0; i < 500 && s.vehicles.length === 0; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 8 });
    }
    const origin = s.vehicles[0]?.purpose.fromBuildingId;
    expect(origin).toBeDefined();

    // トリップ完了（到着して消える）を模す
    s.vehicles = s.vehicles.filter((v) => v.purpose.fromBuildingId !== origin);
    let respawned = false;
    for (let i = 0; i < 2000 && !respawned; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 8 });
      respawned = s.vehicles.some((v) => v.purpose.fromBuildingId === origin);
    }
    expect(respawned).toBe(true);
  });
});

/**
 * 施設トリップ（通学）の枠は通常の外出と**別**であること。
 *
 * 枠を共有すると、住宅はほぼ常に1台出ているので通学の抽選に当たっても
 * ほぼ必ず上限に弾かれ、未処理需要が増えるだけで**路上の車が増えない**。
 * 実測で通過台数は+3%しか変わらず、「置いた瞬間に流量が変わるのが見える」という
 * 受け入れ基準（`docs/m6-plan.md` §5 死因2）を満たせなかった。
 * 枠を分けると学校周辺の通過が+30%になり、目で見て分かる差になる。
 */
describe('施設トリップの枠は通常の外出と別', () => {
  it('通常の外出で埋まっていても、通学の車は出せる', () => {
    const s = emptyState();
    for (let x = 0; x < 20; x++) setRoad(s.grid, x, 5, true);
    const home = addBuilding(s, 'residential', 1, 4);
    addBuilding(s, 'commercial', 10, 4);
    // 学校を道路沿いに置く
    s.facilities.push({ id: s.nextId++, defId: 'school', pos: { x: 6, y: 4 } });
    s.grid.facilityIndex[`6,4`] = s.facilities[0]!.id;

    const rng = createRng(11);
    // 通常の外出が1台出るまで回す
    for (let i = 0; i < 3000 && s.vehicles.length === 0; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 8 });
    }
    expect(s.vehicles.length).toBeGreaterThan(0);

    // その1台を帰らせないまま回すと、通学の車が別枠で出る
    let schoolTrips = 0;
    for (let i = 0; i < 3000 && schoolTrips === 0; i++) {
      spawnPeopleTrips(s, createCongestionMap(), rng, { remaining: 8 });
      schoolTrips = s.vehicles.filter((v) => v.purpose.to.x === 6 && v.purpose.to.y === 4).length;
    }
    expect(schoolTrips).toBeGreaterThan(0);
    // ただし通学も「1棟につき同時1台」は守る
    const fromHome = s.vehicles.filter(
      (v) => v.purpose.fromBuildingId === home.id && v.purpose.to.x === 6,
    );
    expect(fromHome.length).toBeLessThanOrEqual(TRAFFIC.MAX_ACTIVE_TRIPS_PER_BUILDING);
  });
});
