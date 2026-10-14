import { describe, it, expect } from 'vitest';
import { ECONOMY, GROWTH, MOVE_IN, SPACE, TRAFFIC } from './balance';
import {
  buildingIdAt,
  hasArterialRoad,
  hasRoad,
  roadRankAt,
  setZone,
  terrainAt,
  zoneAt,
} from './grid';
import {
  tileKey,
  type Building,
  type BuildOp,
  type GameState,
  type TilePos,
  type ZoneType,
} from './types';
import {
  advance,
  applyOp,
  canApplyOp,
  createWorld,
  districtPrice,
  listRoadTiles,
  previewDemolishArea,
  previewPaintZone,
} from './world';

const CS = SPACE.CHUNK_SIZE;
const SEED = 20260729;

/** 状態のハッシュ。決定論の回帰検知に使う（車の位置まで含める） */
function hashState(s: GameState): string {
  const parts = [
    s.tick,
    s.money.toFixed(4),
    s.rngState,
    s.nextId,
    s.vehicles.length,
    s.progress.totalTrips,
    s.progress.failedTrips,
  ];
  for (const v of s.vehicles) {
    parts.push(
      v.id,
      v.phase,
      v.accessProgress.toFixed(6),
      v.edgeIndex,
      v.edgeProgress.toFixed(6),
      v.path.length,
    );
  }
  for (const key of Object.keys(s.grid.road).sort()) {
    const arr = s.grid.road[key];
    if (arr)
      parts.push(
        key,
        arr.reduce((a, b) => a + b, 0),
      );
  }
  return parts.join('|');
}

/** 平地の道路タイルを横一列に敷く操作を作る */
function roadLine(state: GameState, y: number, x0: number, len: number): BuildOp {
  const tiles: TilePos[] = [];
  for (let i = 0; i < len; i++) tiles.push({ x: x0 + i, y });
  void state;
  return { kind: 'buildRoad', tiles };
}

/** 建物を直接置く（growth/index.test.ts の `place` に倣う。applyOp を通さない最小構成） */
function placeBuilding(state: GameState, x: number, y: number, zone: ZoneType): Building {
  const b: Building = {
    id: state.nextId++,
    pos: { x, y },
    zone,
    level: 1,
    occupied: true,
    satisfaction: GROWTH.SATISFACTION_START,
    lowSatisfactionDays: 0,
    tripsOkToday: 0,
    tripsFailToday: 0,
  };
  setZone(state.grid, x, y, zone);
  state.buildings.push(b);
  state.grid.buildingIndex[tileKey(x, y)] = b.id;
  return b;
}

/** 山・水を避けた平地の行を探す */

/** 道路沿いに住宅と商業を置き、実際のトリップが出る最小構成を作る */
function seedTrafficAlong(w: ReturnType<typeof createWorld>, row: { y: number; x0: number }): void {
  placeBuilding(w.state, row.x0 + 1, row.y + 1, 'residential');
  placeBuilding(w.state, row.x0 + 9, row.y + 1, 'commercial');
}

/**
 * 車が1台走り出すまで進める。
 *
 * `MAX_ACTIVE_TRIPS_PER_BUILDING` を入れてから、住宅1棟の街では
 * 「出発 → 到着 → 消滅 → しばらく0台」を繰り返すようになった。
 * 固定tick進めてから台数を見ると、たまたま帰宅後を覗いて落ちる。
 * **車が出ること自体を確かめたいので、出た瞬間で止める。**
 */
function advanceUntilVehicle(w: ReturnType<typeof createWorld>, maxTicks = 3000): void {
  for (let i = 0; i < maxTicks && w.state.vehicles.length === 0; i++) advance(w, 1);
}

function findPlainRow(state: GameState, len: number): { y: number; x0: number } | null {
  for (let y = 0; y < CS; y++) {
    for (let x0 = 0; x0 + len <= CS; x0++) {
      let allPlain = true;
      for (let i = 0; i < len; i++) {
        if (terrainAt(state.grid, x0 + i, y) !== 'plain') {
          allPlain = false;
          break;
        }
      }
      if (allPlain) return { y, x0 };
    }
  }
  return null;
}

describe('createWorld', () => {
  it('開始チャンクだけが解放されている', () => {
    const w = createWorld(SEED);
    expect(w.state.districts).toEqual([{ cx: 0, cy: 0, purchased: false }]);
    expect(terrainAt(w.state.grid, 0, 0)).toBeDefined();
    expect(terrainAt(w.state.grid, CS, 0)).toBeUndefined();
  });

  it('初期資金と時刻が仕様どおり', () => {
    const w = createWorld(SEED);
    expect(w.state.money).toBe(ECONOMY.START_MONEY);
    expect(w.state.tick).toBe(0);
    expect(w.state.vehicles).toEqual([]);
  });

  it('同じシードなら完全に同じ初期状態になる', () => {
    expect(hashState(createWorld(SEED).state)).toBe(hashState(createWorld(SEED).state));
  });
});

describe('決定論', () => {
  it('同一シード・同一操作列で10,000tick後の状態が一致する', () => {
    const run = () => {
      const w = createWorld(SEED);
      const row = findPlainRow(w.state, 12);
      expect(row).not.toBeNull();
      applyOp(w, roadLine(w.state, row!.y, row!.x0, 12));
      applyOp(w, {
        kind: 'buildRoad',
        tiles: Array.from({ length: 6 }, (_, i) => ({ x: row!.x0 + 3, y: row!.y + i })),
      });
      advance(w, 10000);
      return hashState(w.state);
    };
    expect(run()).toBe(run());
  });

  it('異なるシードでは状態が変わる', () => {
    const w1 = createWorld(1);
    const w2 = createWorld(2);
    advance(w1, 100);
    advance(w2, 100);
    expect(hashState(w1.state)).not.toBe(hashState(w2.state));
  });
});

describe('入居スケジュール', () => {
  it('入居は60tick間隔で反映し、日次レポートは日境界まで更新しない', () => {
    const w = createWorld(SEED);
    w.state.money = 999999;
    const row = findPlainRow(w.state, 12)!;
    const roads = Array.from({ length: 12 }, (_, i) => ({ x: row.x0 + i, y: row.y }));
    const zones = roads
      .map((t) => ({ x: t.x, y: t.y + 1 }))
      .filter((t) => terrainAt(w.state.grid, t.x, t.y) === 'plain');
    expect(applyOp(w, { kind: 'buildRoad', tiles: roads }).ok).toBe(true);
    expect(applyOp(w, { kind: 'paintZone', zone: 'residential', tiles: zones }).ok).toBe(true);

    advance(w, MOVE_IN.INTERVAL_TICKS - 1);
    expect(w.state.buildings).toHaveLength(0);
    expect(w.state.progress.dayReports).toHaveLength(0);

    advance(w, 1);
    expect(w.state.buildings.length).toBeGreaterThan(0);
    expect(w.state.progress.dayReports).toHaveLength(0);
  });
});

describe('道路の建設と撤去', () => {
  it('通常道路を幹線へ上げ下げでき、buildRoadはランク1の意味を保つ', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 3)!;
    const tiles = Array.from({ length: 3 }, (_, i) => ({ x: row.x0 + i, y: row.y }));
    w.state.money = 1000;
    expect(applyOp(w, { kind: 'buildRoad', tiles })).toEqual({ ok: true });
    expect(tiles.map((tile) => roadRankAt(w.state.grid, tile.x, tile.y))).toEqual([1, 1, 1]);

    const afterBuild = w.state.money;
    expect(applyOp(w, { kind: 'upgradeRoad', tiles })).toEqual({ ok: true });
    expect(tiles.map((tile) => roadRankAt(w.state.grid, tile.x, tile.y))).toEqual([2, 2, 2]);
    expect(w.state.money).toBe(afterBuild - ECONOMY.COST_UPGRADE_ROAD * tiles.length);

    // 既存 buildRoad を幹線に重ねてもランクを下げず、課金もしない。
    const afterUpgrade = w.state.money;
    expect(applyOp(w, { kind: 'buildRoad', tiles })).toEqual({ ok: true });
    expect(roadRankAt(w.state.grid, tiles[0]!.x, tiles[0]!.y)).toBe(2);
    expect(w.state.money).toBe(afterUpgrade);

    expect(applyOp(w, { kind: 'downgradeRoad', tiles })).toEqual({ ok: true });
    expect(tiles.map((tile) => roadRankAt(w.state.grid, tile.x, tile.y))).toEqual([1, 1, 1]);
    expect(w.state.money).toBe(afterUpgrade - ECONOMY.COST_DOWNGRADE_ROAD * tiles.length);
  });

  it('GameStateをJSON往復しても幹線ランクが保たれる', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 1)!;
    const tile = { x: row.x0, y: row.y };
    applyOp(w, { kind: 'buildRoad', tiles: [tile] });
    applyOp(w, { kind: 'upgradeRoad', tiles: [tile] });

    const restored = JSON.parse(JSON.stringify(w.state)) as GameState;
    expect(roadRankAt(restored.grid, tile.x, tile.y)).toBe(2);
    expect(hasArterialRoad(restored.grid)).toBe(true);
  });

  it('建設すると道路が立ち、費用が引かれる', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 5)!;
    const before = w.state.money;
    expect(applyOp(w, roadLine(w.state, row.y, row.x0, 5)).ok).toBe(true);
    expect(hasRoad(w.state.grid, row.x0, row.y)).toBe(true);
    expect(w.state.money).toBe(before - ECONOMY.COST_ROAD * 5);
  });

  it('同じタイルに二重に建設しても二重課金されない', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 5)!;
    applyOp(w, roadLine(w.state, row.y, row.x0, 5));
    const after = w.state.money;
    applyOp(w, roadLine(w.state, row.y, row.x0, 5));
    expect(w.state.money).toBe(after);
  });

  it('世界の外には建設できない', () => {
    const w = createWorld(SEED);
    const r = canApplyOp(w, { kind: 'buildRoad', tiles: [{ x: CS + 1, y: 0 }] });
    expect(r.ok).toBe(false);
  });

  it('資金が足りなければ建設できず、残高は負にならない', () => {
    const w = createWorld(SEED);
    w.state.money = 5;
    const row = findPlainRow(w.state, 5)!;
    expect(applyOp(w, roadLine(w.state, row.y, row.x0, 5)).ok).toBe(false);
    expect(w.state.money).toBe(5);
  });

  it('撤去すると道路が消え、その上の車も消える', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 12)!;
    applyOp(w, roadLine(w.state, row.y, row.x0, 12));
    seedTrafficAlong(w, row);
    advanceUntilVehicle(w);
    expect(w.state.vehicles.length).toBeGreaterThan(0);

    const tiles = Array.from({ length: 12 }, (_, i) => ({ x: row.x0 + i, y: row.y }));
    applyOp(w, { kind: 'demolishRoad', tiles });
    expect(hasRoad(w.state.grid, row.x0, row.y)).toBe(false);
    expect(w.state.vehicles).toHaveLength(0);
  });

  it('撤去で消えた車は失敗トリップに数えない', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 12)!;
    applyOp(w, roadLine(w.state, row.y, row.x0, 12));
    advance(w, 500);
    const failedBefore = w.state.progress.failedTrips;
    const tiles = Array.from({ length: 12 }, (_, i) => ({ x: row.x0 + i, y: row.y }));
    applyOp(w, { kind: 'demolishRoad', tiles });
    expect(w.state.progress.failedTrips).toBe(failedBefore);
  });
});

describe('区画', () => {
  it('道路の上には塗れない', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 3)!;
    applyOp(w, roadLine(w.state, row.y, row.x0, 3));
    const r = canApplyOp(w, {
      kind: 'paintZone',
      zone: 'residential',
      tiles: [{ x: row.x0, y: row.y }],
    });
    expect(r.ok).toBe(false);
  });

  it('平地に塗れて費用が引かれる', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 3)!;
    const before = w.state.money;
    // 道路とは別の行に塗る
    const y = row.y + 1 < CS ? row.y + 1 : row.y - 1;
    const tiles = [{ x: row.x0, y }];
    if (terrainAt(w.state.grid, row.x0, y) !== 'plain') return; // 地形次第でスキップ
    expect(applyOp(w, { kind: 'paintZone', zone: 'commercial', tiles }).ok).toBe(true);
    expect(zoneAt(w.state.grid, row.x0, y)).toBe('commercial');
    expect(w.state.money).toBe(before - ECONOMY.COST_ZONE);
  });
});

describe('W1: 編集操作（M3 docs/m3-plan.md §4）', () => {
  it('W1-1: 道路を敷くと下の区画・建物が消え、buildingIndexからも消え、関連車両も消える（幽霊建物の修正）', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 3)!;
    const bx = row.x0 + 1;
    const by = row.y;
    const b = placeBuilding(w.state, bx, by, 'residential');

    // この建物を出発元にしている車
    w.state.vehicles.push({
      id: w.state.nextId++,
      kind: 'car',
      mode: 'road',
      leg: 'outbound',
      legStartedTick: 0,
      dwellUntilTick: null,
      phase: 'road',
      accessProgress: 0,
      path: [{ x: bx, y: by }],
      edgeIndex: 0,
      edgeProgress: 0,
      purpose: { fromBuildingId: b.id, from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, startedTick: 0 },
    });
    // この建物を目的地にしている車
    w.state.vehicles.push({
      id: w.state.nextId++,
      kind: 'truck',
      mode: 'road',
      leg: 'outbound',
      legStartedTick: 0,
      dwellUntilTick: null,
      phase: 'road',
      accessProgress: 0,
      path: [{ x: bx, y: by }],
      edgeIndex: 0,
      edgeProgress: 0,
      purpose: { fromBuildingId: -1, from: { x: 0, y: 0 }, to: { x: bx, y: by }, startedTick: 0 },
    });
    // 無関係な車（残るはず）
    w.state.vehicles.push({
      id: w.state.nextId++,
      kind: 'car',
      mode: 'road',
      leg: 'outbound',
      legStartedTick: 0,
      dwellUntilTick: null,
      phase: 'road',
      accessProgress: 0,
      path: [{ x: 0, y: 0 }],
      edgeIndex: 0,
      edgeProgress: 0,
      purpose: { fromBuildingId: -1, from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, startedTick: 0 },
    });

    const before = w.state.money;
    const r = applyOp(w, { kind: 'buildRoad', tiles: [{ x: bx, y: by }] });
    expect(r.ok).toBe(true);

    expect(hasRoad(w.state.grid, bx, by)).toBe(true);
    expect(zoneAt(w.state.grid, bx, by)).toBeNull();
    expect(buildingIdAt(w.state.grid, bx, by)).toBeUndefined();
    expect(w.state.buildings.find((x) => x.id === b.id)).toBeUndefined();
    expect(w.state.vehicles).toHaveLength(1);
    expect(w.state.vehicles[0]!.purpose.to).toEqual({ x: 0, y: 0 });
    // 区画の塗り直しは無料。道路建設費だけ引かれる（1タイル分）
    expect(w.state.money).toBe(before - ECONOMY.COST_ROAD);
  });

  it('W1-1: 撤去された車は失敗トリップに数えない', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 1)!;
    const b = placeBuilding(w.state, row.x0, row.y, 'commercial');
    w.state.vehicles.push({
      id: w.state.nextId++,
      kind: 'car',
      mode: 'road',
      leg: 'outbound',
      legStartedTick: 0,
      dwellUntilTick: null,
      phase: 'road',
      accessProgress: 0,
      path: [{ x: row.x0, y: row.y }],
      edgeIndex: 0,
      edgeProgress: 0,
      purpose: { fromBuildingId: b.id, from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, startedTick: 0 },
    });
    const failedBefore = w.state.progress.failedTrips;
    applyOp(w, { kind: 'buildRoad', tiles: [{ x: row.x0, y: row.y }] });
    expect(w.state.progress.failedTrips).toBe(failedBefore);
  });

  it('W1-3: demolishArea は矩形内の道路・区画・建物をすべて消し、費用は道路撤去費のみ', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 4)!;
    const y = row.y;
    // x0: 道路のみ / x0+1: 建物（入居済み） / x0+2: 区画のみ（未入居） / x0+3: 何もない
    applyOp(w, { kind: 'buildRoad', tiles: [{ x: row.x0, y }] });
    const b = placeBuilding(w.state, row.x0 + 1, y, 'commercial');
    applyOp(w, { kind: 'paintZone', zone: 'industrial', tiles: [{ x: row.x0 + 2, y }] });

    const before = w.state.money;
    const tiles: TilePos[] = Array.from({ length: 4 }, (_, i) => ({ x: row.x0 + i, y }));
    const r = applyOp(w, { kind: 'demolishArea', tiles });
    expect(r.ok).toBe(true);

    for (const t of tiles) {
      expect(hasRoad(w.state.grid, t.x, t.y)).toBe(false);
      expect(zoneAt(w.state.grid, t.x, t.y)).toBeNull();
      expect(buildingIdAt(w.state.grid, t.x, t.y)).toBeUndefined();
    }
    expect(w.state.buildings.find((x) => x.id === b.id)).toBeUndefined();
    // 区画・建物の撤去は無料。道路撤去費（1タイル分）だけ引かれる
    expect(w.state.money).toBe(before - ECONOMY.COST_DEMOLISH_ROAD);
  });

  it('W1-3: demolishArea で消えた車は失敗トリップに数えない', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 12)!;
    applyOp(w, roadLine(w.state, row.y, row.x0, 12));
    advance(w, 500);
    const failedBefore = w.state.progress.failedTrips;
    const tiles = Array.from({ length: 12 }, (_, i) => ({ x: row.x0 + i, y: row.y }));
    applyOp(w, { kind: 'demolishArea', tiles });
    expect(w.state.vehicles).toHaveLength(0);
    expect(w.state.progress.failedTrips).toBe(failedBefore);
  });
});

describe('D8: 有料編集操作は全か無か', () => {
  it('paintZone: 合計費用が足りなければ1タイルも塗らず理由を返す', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 5)!;
    const tiles: TilePos[] = Array.from({ length: 5 }, (_, i) => ({ x: row.x0 + i, y: row.y }));
    w.state.money = ECONOMY.COST_ZONE * 2 + Math.floor(ECONOMY.COST_ZONE / 2);
    const before = w.state.money;

    const r = applyOp(w, { kind: 'paintZone', zone: 'residential', tiles });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('資金');
    for (const t of tiles) expect(zoneAt(w.state.grid, t.x, t.y)).toBeNull();
    expect(w.state.money).toBe(before);
  });

  it('paintZone: 1タイルも塗れないほど資金が無いときだけ操作全体を拒否する', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 3)!;
    const tiles: TilePos[] = Array.from({ length: 3 }, (_, i) => ({ x: row.x0 + i, y: row.y }));
    w.state.money = ECONOMY.COST_ZONE - 1; // 1枚も払えない
    const before = w.state.money;

    const r = applyOp(w, { kind: 'paintZone', zone: 'commercial', tiles });
    expect(r.ok).toBe(false);
    for (const t of tiles) expect(zoneAt(w.state.grid, t.x, t.y)).toBeNull();
    expect(w.state.money).toBe(before); // 何も変化しない
  });

  it('buildRoad: 合計費用が足りなければ1タイルも建設しない', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 4)!;
    const tiles: TilePos[] = Array.from({ length: 4 }, (_, i) => ({ x: row.x0 + i, y: row.y }));
    w.state.money = ECONOMY.COST_ROAD * 2;
    const before = w.state.money;

    const r = applyOp(w, { kind: 'buildRoad', tiles });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('資金');
    for (const t of tiles) expect(hasRoad(w.state.grid, t.x, t.y)).toBe(false);
    expect(w.state.money).toBe(before);
  });

  it('upgradeRoad: 合計費用が足りなければ1タイルも拡幅しない', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 3)!;
    const tiles = Array.from({ length: 3 }, (_, i) => ({ x: row.x0 + i, y: row.y }));
    w.state.money = ECONOMY.COST_ROAD * tiles.length;
    expect(applyOp(w, { kind: 'buildRoad', tiles }).ok).toBe(true);
    w.state.money = ECONOMY.COST_UPGRADE_ROAD * 2;

    const r = applyOp(w, { kind: 'upgradeRoad', tiles });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('資金');
    expect(tiles.map((t) => roadRankAt(w.state.grid, t.x, t.y))).toEqual([1, 1, 1]);
    expect(w.state.money).toBe(ECONOMY.COST_UPGRADE_ROAD * 2);
  });

  it('demolishArea: 道路撤去費が足りなければ無料の区画・建物も変更しない', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 3)!;
    const y = row.y;
    applyOp(w, roadLine(w.state, y, row.x0, 2));
    const b = placeBuilding(w.state, row.x0 + 2, y, 'commercial');

    w.state.money = ECONOMY.COST_DEMOLISH_ROAD;
    const before = w.state.money;
    const tiles: TilePos[] = Array.from({ length: 3 }, (_, i) => ({ x: row.x0 + i, y }));
    const r = applyOp(w, { kind: 'demolishArea', tiles });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('資金');
    expect(hasRoad(w.state.grid, row.x0, y)).toBe(true);
    expect(hasRoad(w.state.grid, row.x0 + 1, y)).toBe(true);
    expect(w.state.buildings.find((x) => x.id === b.id)).toBeDefined();
    expect(w.state.money).toBe(before);
  });

  it('previewPaintZone: 合計費用が足りなければ対象全体が赤になる', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 4)!;
    const tiles: TilePos[] = Array.from({ length: 4 }, (_, i) => ({ x: row.x0 + i, y: row.y }));
    w.state.money = ECONOMY.COST_ZONE;
    expect(previewPaintZone(w, 'industrial', tiles)).toEqual([false, false, false, false]);
  });

  it('previewDemolishArea: 道路撤去費が足りなければ無料部分も含めて全体が赤になる', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 2)!;
    applyOp(w, { kind: 'buildRoad', tiles: [{ x: row.x0, y: row.y }] });
    w.state.money = 0;
    const tiles: TilePos[] = [
      { x: row.x0, y: row.y },
      { x: row.x0 + 1, y: row.y },
    ];
    expect(previewDemolishArea(w, tiles)).toEqual([false, false]);
  });
});

describe('エリア購入', () => {
  it('初回価格は基準額（開始チャンクは有償に数えない）', () => {
    const w = createWorld(SEED);
    expect(districtPrice(w.state)).toBe(ECONOMY.DISTRICT_BASE_PRICE);
  });

  it('隣接していないチャンクは買えない', () => {
    const w = createWorld(SEED);
    w.state.money = 999999;
    expect(canApplyOp(w, { kind: 'buyDistrict', cx: 3, cy: 3 }).ok).toBe(false);
  });

  it('隣接チャンクを買うと地形が生成され、価格が上がる', () => {
    const w = createWorld(SEED);
    w.state.money = 999999;
    expect(applyOp(w, { kind: 'buyDistrict', cx: 1, cy: 0 }).ok).toBe(true);
    expect(terrainAt(w.state.grid, CS + 1, 1)).toBeDefined();
    expect(districtPrice(w.state)).toBeGreaterThan(ECONOMY.DISTRICT_BASE_PRICE);
  });

  it('すでに解放済みのチャンクは買えない', () => {
    const w = createWorld(SEED);
    w.state.money = 999999;
    expect(canApplyOp(w, { kind: 'buyDistrict', cx: 0, cy: 0 }).ok).toBe(false);
  });
});

describe('交通', () => {
  it('道路がなければ車は生まれない', () => {
    const w = createWorld(SEED);
    advance(w, 1000);
    expect(w.state.vehicles).toHaveLength(0);
  });

  it('道路と建物があると車が走り出す', () => {
    // **道路だけでは車は走らない。** 以前は「建物が無い間だけ道路上をランダムに走る
    // ダミートリップ」があったが、幽霊自動車に見えるため廃止した。
    // 車は建物どうしのトリップとしてのみ発生する
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 12)!;
    applyOp(w, roadLine(w.state, row.y, row.x0, 12));
    seedTrafficAlong(w, row);
    advanceUntilVehicle(w);
    expect(w.state.vehicles.length).toBeGreaterThan(0);
    expect(listRoadTiles(w.state)).toHaveLength(12);
  });

  it('車の数が上限を超えない', { timeout: 60000 }, () => {
    const w = createWorld(SEED);
    // 格子状の道路網（現実的な街の形）
    const tiles: TilePos[] = [];
    for (let y = 0; y < CS; y++) {
      for (let x = 0; x < CS; x++) {
        if ((x % 3 === 0 || y % 3 === 0) && terrainAt(w.state.grid, x, y) === 'plain') {
          tiles.push({ x, y });
        }
      }
    }
    w.state.money = 9999999;
    applyOp(w, { kind: 'buildRoad', tiles });
    // 車は建物どうしのトリップでしか出ないので、道路沿いに建物を敷き詰める
    for (let y = 1; y < CS - 1; y += 3) {
      for (let x = 1; x < CS - 1; x += 3) {
        if (terrainAt(w.state.grid, x, y) !== 'plain') continue;
        if (hasRoad(w.state.grid, x, y)) continue;
        placeBuilding(w.state, x, y, x % 2 === 0 ? 'residential' : 'commercial');
      }
    }
    advance(w, 3000);
    expect(w.state.vehicles.length).toBeLessThanOrEqual(TRAFFIC.MAX_VEHICLES);
    expect(w.state.vehicles.length).toBeGreaterThan(0);
  });

  it('1tickの経路探索回数に上限がかかる（街が育っても tick 時間が伸び続けない）', () => {
    const w = createWorld(SEED);
    const tiles: TilePos[] = [];
    for (let y = 0; y < CS; y++) {
      for (let x = 0; x < CS; x++) {
        if (terrainAt(w.state.grid, x, y) === 'plain') tiles.push({ x, y });
      }
    }
    w.state.money = 9999999;
    applyOp(w, { kind: 'buildRoad', tiles });

    const before = w.state.progress.totalTrips;
    advance(w, 1);
    // 道路800タイル超なら発生期待値は8以上だが、上限で頭打ちになる
    expect(w.state.progress.totalTrips - before).toBeLessThanOrEqual(4);
  });

  it('進行状況にトリップ数が記録される', () => {
    const w = createWorld(SEED);
    const row = findPlainRow(w.state, 12)!;
    applyOp(w, roadLine(w.state, row.y, row.x0, 12));
    seedTrafficAlong(w, row);
    advance(w, 600);
    expect(w.state.progress.totalTrips).toBeGreaterThan(0);
  });
});

/**
 * 撤去ツールで施設を消せること（オーナー報告「施設が撤去できない」）。
 *
 * `removeFacility` op は最初から実装されていたが、**UI からも撤去ツールからも
 * 一度も呼ばれていなかった**。施設は「どこに置くか」を考えて置くものなので、
 * 置き直せないのは致命的。
 */
describe('撤去ツールと施設', () => {
  function townWithPark(): { w: ReturnType<typeof createWorld>; pos: TilePos } {
    const w = createWorld(SEED);
    w.state.money = 100000;
    const row = findPlainRow(w.state, 12)!;
    applyOp(w, roadLine(w.state, row.y, row.x0, 12));
    const pos = { x: row.x0 + 2, y: row.y + 1 };
    const placed = applyOp(w, { kind: 'placeFacility', defId: 'park', pos });
    expect(placed).toEqual({ ok: true });
    expect(w.state.facilities).toHaveLength(1);
    return { w, pos };
  }

  it('矩形撤去で施設が消え、facilityIndex にも残らない', () => {
    const { w, pos } = townWithPark();
    const before = w.state.money;

    expect(applyOp(w, { kind: 'demolishArea', tiles: [pos] })).toEqual({ ok: true });
    expect(w.state.facilities).toHaveLength(0);
    expect(w.state.grid.facilityIndex[tileKey(pos.x, pos.y)]).toBeUndefined();
    // 返金は removeFacility と同じ扱い（撤去ツール側に率を書き写していないこと）
    expect(w.state.money).toBeGreaterThan(before);
  });

  it('施設しか無い矩形でも撤去が受け付けられる', () => {
    const { w, pos } = townWithPark();
    expect(canApplyOp(w, { kind: 'demolishArea', tiles: [pos] }).ok).toBe(true);
  });

  it('消した跡地には同じ施設をもう一度置ける（置き直せること）', () => {
    const { w, pos } = townWithPark();
    applyOp(w, { kind: 'demolishArea', tiles: [pos] });
    expect(applyOp(w, { kind: 'placeFacility', defId: 'park', pos })).toEqual({ ok: true });
    expect(w.state.facilities).toHaveLength(1);
  });
});
