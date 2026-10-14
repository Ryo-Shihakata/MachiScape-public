/**
 * シミュレーションの入口（実装書 §2）。
 *
 * - `createWorld(seed)` で初期状態を作る
 * - `advance(state, ticks)` で時間を進める（固定タイムステップ）
 * - `applyOp(state, op)` でプレイヤーの建設操作を適用する
 *
 * GameState は直列化可能なプレーンオブジェクトに保つ。混雑度と RNG のような
 * 「毎tick更新される作業データ」も state に含め、外から状態を持ち込まない
 * （持ち込むと決定論とセーブ/ロードが壊れる）。
 */

import { ECONOMY, FACILITY, MOVE_IN, ROAD, SPACE, TIME } from './balance';
import { facilityDef } from './facility/defs';
import { facilityTiles, satisfactionFloorAt } from './facility';
import {
  addChunk,
  buildingIdAt,
  createGrid,
  facilityIdAt,
  hasChunk,
  hasRoad,
  hasRoadAccess,
  isBuildableTerrain,
  roadRankAt,
  setRoad,
  setRoadRank,
  setZone,
  terrainAt,
  toChunk,
  zoneAt,
} from './grid';
import { settleDay } from './economy';
import {
  computeBuildingStats,
  computeDemand,
  processLogistics,
  processMoveIn,
  updateSatisfaction,
} from './growth';
import { generateChunk, generateStartChunk } from './mapgen';
import { checkMilestones } from './progress';
import { isUnlocked } from './progress/milestones';
import type { Rng } from './rng';
import { validateBridge } from './road/bridge';
import { createCongestionMap, type CongestionMap } from './road/congestion';
import { orthogonalIntersectionAt } from './road/intersection';
import { ensureIntersectionSignal, spawnFreightTrips, stepTraffic } from './traffic';
import {
  tileKey,
  type BuildOp,
  type GameState,
  type OpResult,
  type TilePos,
  type ZoneType,
} from './types';

const CS = SPACE.CHUNK_SIZE;

/**
 * 混雑度と RNG は GameState に載せる。
 * 型は types.ts（他担当と共有）に足さず、ここで拡張して持つ。
 */
export interface World {
  state: GameState;
  congestion: CongestionMap;
  rng: Rng;
}

export function createWorld(seed: number): World {
  const start = generateStartChunk(seed);
  const grid = createGrid();
  addChunk(grid, 0, 0, start.terrain);

  const state: GameState = {
    seed: start.seed,
    rngState: start.seed >>> 0,
    tick: 0,
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
    intersectionPriorities: {},
    intersectionLastServedAxes: {},
    intersectionSignals: {},
  };

  return { state, congestion: createCongestionMap(), rng: { state: state.rngState } };
}

/**
 * 解放済みチャンクにある道路タイルを列挙する。
 *
 * **毎tickの処理では使っていない。** 以前はダミートリップ（建物が無い間だけ道路上を
 * ランダムに走る車）の発生元として `advance` が毎回呼んでいたが、ダミートリップを
 * 廃止したので不要になった。解放済みチャンク数 × 1,024 タイルの走査が
 * 毎フレーム走っていたため、エリアを買い足すほど重くなる構造だった。
 */
export function listRoadTiles(state: GameState): TilePos[] {
  const out: TilePos[] = [];
  for (const d of state.districts) {
    for (let ly = 0; ly < CS; ly++) {
      for (let lx = 0; lx < CS; lx++) {
        const x = d.cx * CS + lx;
        const y = d.cy * CS + ly;
        if (hasRoad(state.grid, x, y)) out.push({ x, y });
      }
    }
  }
  return out;
}

/** ticks ぶん進める。 */
export function advance(world: World, ticks = 1): void {
  for (let i = 0; i < ticks; i++) {
    const dayBefore = day(world.state);
    world.state.tick++;
    stepTraffic(world.state, world.congestion, world.rng);

    // 入居だけは需要の変化をすぐ街へ反映するため、日次処理から切り出して60tickごとに回す。
    // 日境界では従来どおり入居を日次処理より先に行い、精算には入居前の集計を渡す。
    let statsBeforeMoveIn: ReturnType<typeof computeBuildingStats> | undefined;
    if (world.state.tick % MOVE_IN.INTERVAL_TICKS === 0) {
      statsBeforeMoveIn = computeBuildingStats(world.state);
      const demand = computeDemand(world.state, statsBeforeMoveIn);
      processMoveIn(world.state, statsBeforeMoveIn, demand, world.rng);
    }

    // 日が変わった瞬間に税収・満足度・在庫を従来の順序で処理する。
    // 物流要求は建物ごとの時刻へ分散するが、日境界分はこのパイプライン内で出す。
    if (day(world.state) !== dayBefore) stepDay(world, statsBeforeMoveIn);
    else spawnFreightTrips(world.state, world.congestion, { remaining: FREIGHT_BUDGET_PER_TICK });
    world.state.rngState = world.rng.state;
  }
}

/**
 * 1ゲーム日ぶんの処理。順序は `pipeline.ts` が定めたとおりに固定する
 * （順序を変えると同じ入力でも結果が変わる）。
 */
export function stepDay(
  world: World,
  statsBeforeMoveIn: ReturnType<typeof computeBuildingStats> = computeBuildingStats(world.state),
): void {
  const { state } = world;
  processLogistics(state);
  // 関数自体は毎tick呼ぶが、building.id 由来の時刻に一致する商業だけが要求する。
  // 各商業の要求は1日1回のままなので、供給不足の失敗を毎tick重ねることはない。
  spawnFreightTrips(state, world.congestion, { remaining: FREIGHT_BUDGET_PER_TICK });
  updateSatisfaction(state);
  const rewards = checkMilestones(state);
  settleDay(state, statsBeforeMoveIn, rewards);

  // 直近1日の実績を確定させ、当日のカウンタを空にする。
  // 需要はこの「直近1日」で評価されるので、道路を直せば翌日から改善が反映される
  state.progress.tripsLastDay = state.progress.tripsToday;
  state.progress.failedLastDay = state.progress.failedToday;
  state.progress.unservedLastDay = state.progress.unservedToday;
  state.progress.tripsToday = 0;
  state.progress.failedToday = 0;
  state.progress.unservedToday = 0;
}

/** 同じtickに出せるトラックの上限。idの剰余が衝突した場合も経路探索回数を抑える。 */
const FREIGHT_BUDGET_PER_TICK = 30;

/** HUD 用: 現在の需要バー（実装書 §12.2） */
export function currentDemand(state: GameState) {
  return computeDemand(state, computeBuildingStats(state));
}

/** HUD 用: 人口などの集計 */
export function currentStats(state: GameState) {
  return computeBuildingStats(state);
}

export const day = (state: GameState): number => Math.floor(state.tick / TIME.TICKS_PER_DAY);

// ---------------------------------------------------------------------------
// 建設操作（実装書 §12.4）
// ---------------------------------------------------------------------------

const ok: OpResult = { ok: true };
const fail = (reason: string): OpResult => ({ ok: false, reason });

/**
 * 操作を適用する。UI の事前チェックにも同じ関数（`canApplyOp`）を使うこと。
 * 検証を二重実装すると「プレビューでは置けるのに建設できない」がすぐ生まれる。
 */
export function applyOp(world: World, op: BuildOp): OpResult {
  const check = canApplyOp(world, op);
  if (!check.ok) return check;

  const { state } = world;
  switch (op.kind) {
    case 'buildRoad': {
      // D8: canApplyOp が対象全体の費用を先に検証するため、ここでは全タイルを適用する。
      // 資金不足時は本体へ入らず、道路・区画・建物を1タイルも変更しない。
      let cost = 0;
      for (const t of usableTiles(world, op)) {
        if (hasRoad(state.grid, t.x, t.y)) {
          // 既に道路がある：無料。区画・建物の幽霊化だけ直す（W1-1）
          clearZoneAndBuilding(state, t);
          continue;
        }
        const tileCost = roadTileCost(state, t);
        cost += tileCost;
        setRoad(state.grid, t.x, t.y, true);
        // 道路の下に区画・建物が残ると、税収と人口を出し続けるデータ不整合になる
        // （幽霊建物。実装書 §12.4 W1-1）。道路を優先し、費用は取らない
        clearZoneAndBuilding(state, t);
      }
      state.money -= cost;
      pruneIntersectionState(state);
      initializeIntersectionStateNear(state, op.tiles);
      return ok;
    }
    case 'upgradeRoad': {
      // D8: 対象全体を払えることは canApplyOp で確認済み。部分的な拡幅はしない。
      // ランク変更は接続形状を変えないため、交差点状態には触れない。
      let cost = 0;
      for (const t of usableTiles(world, op)) {
        cost += ECONOMY.COST_UPGRADE_ROAD;
        setRoadRank(state.grid, t.x, t.y, 2);
      }
      state.money -= cost;
      return ok;
    }
    case 'downgradeRoad': {
      let cost = 0;
      for (const t of usableTiles(world, op)) {
        cost += ECONOMY.COST_DOWNGRADE_ROAD;
        setRoadRank(state.grid, t.x, t.y, 1);
      }
      state.money -= cost;
      return ok;
    }
    case 'demolishRoad': {
      let cost = 0;
      for (const t of usableTiles(world, op)) {
        if (!hasRoad(state.grid, t.x, t.y)) continue;
        cost += ECONOMY.COST_DEMOLISH_ROAD;
        setRoad(state.grid, t.x, t.y, false);
      }
      state.money -= cost;
      removeVehiclesOnTiles(state, op.tiles);
      pruneIntersectionState(state);
      initializeIntersectionStateNear(state, op.tiles);
      return ok;
    }
    case 'paintZone': {
      // D8: 対象全体を払えることは canApplyOp で確認済み。部分的な区画塗りはしない。
      let cost = 0;
      for (const t of usableTiles(world, op)) {
        if (zoneAt(state.grid, t.x, t.y) === op.zone) continue;
        const tileCost = zoneTileCost(state, t);
        cost += tileCost;
        clearForest(state, t);
        setZone(state.grid, t.x, t.y, op.zone);
      }
      state.money -= cost;
      return ok;
    }
    case 'eraseZone': {
      for (const t of op.tiles) setZone(state.grid, t.x, t.y, null);
      return ok;
    }
    case 'demolishArea': {
      // D8: 道路撤去費を対象全体ぶん払えることは canApplyOp で確認済み。
      // 資金不足なら無料部分も含めて操作全体を拒否し、ここでは全タイルを撤去し切る。
      let cost = 0;
      const tiles = usableTiles(world, op);
      const demolishedRoadTiles: TilePos[] = [];
      for (const t of tiles) {
        if (hasRoad(state.grid, t.x, t.y)) {
          cost += ECONOMY.COST_DEMOLISH_ROAD;
          setRoad(state.grid, t.x, t.y, false);
          demolishedRoadTiles.push(t);
        }
        // 区画・建物の撤去は無料（実装書 §12.4 W1-3）
        clearZoneAndBuilding(state, t);
      }
      // 施設は矩形に触れていれば丸ごと消える。返金は removeFacility と同じ扱いにするため
      // op を通す（返金率や車の後始末をここに書き写すと、二重管理になって必ずずれる）
      for (const id of facilityIdsTouching(state, tiles)) {
        applyOp(world, { kind: 'removeFacility', id });
      }
      state.money -= cost;
      removeVehiclesOnTiles(state, demolishedRoadTiles);
      pruneIntersectionState(state);
      initializeIntersectionStateNear(state, tiles);
      return ok;
    }
    case 'buyDistrict': {
      state.money -= districtPrice(state);
      addChunk(state.grid, op.cx, op.cy, generateChunk(state.seed, op.cx, op.cy));
      state.districts.push({ cx: op.cx, cy: op.cy, purchased: true });
      return ok;
    }
    case 'setIntersectionPriority': {
      state.intersectionPriorities ??= {};
      const key = tileKey(op.pos.x, op.pos.y);
      if (op.axis === null) delete state.intersectionPriorities[key];
      else state.intersectionPriorities[key] = op.axis;
      // 旧セーブに現示が無い場合は、設定した優先軸を既定の青としてここで移行する。
      // 既存現示は即時反転させず、最低保持と全赤を経由して安全に需要応答させる。
      ensureIntersectionSignal(state, op.pos);
      return ok;
    }
    case 'placeFacility': {
      const def = facilityDef(op.defId);
      if (!def) return fail('施設の定義が見つからない');
      const id = state.nextId++;
      const tiles = facilityTiles(op.pos, def.footprint);
      state.money -= facilityPlacementCost(state, def.cost, tiles);
      state.facilities.push({ id, defId: def.id, pos: { x: op.pos.x, y: op.pos.y } });
      for (const tile of tiles) {
        clearForest(state, tile);
        setZone(state.grid, tile.x, tile.y, null);
        state.grid.facilityIndex[tileKey(tile.x, tile.y)] = id;
      }
      // 公園を置いてから次の日次処理まで下限未満に見える時間を作らない。
      for (const building of state.buildings) {
        if (!building.occupied || building.zone !== 'residential') continue;
        building.satisfaction = Math.max(
          building.satisfaction,
          satisfactionFloorAt(state, building.pos),
        );
      }
      return ok;
    }
    case 'removeFacility': {
      const index = state.facilities.findIndex((facility) => facility.id === op.id);
      const facility = state.facilities[index];
      if (!facility) return fail('施設が見つからない');
      const def = facilityDef(facility.defId);
      if (!def) return fail('施設の定義が見つからない');
      const tiles = facilityTiles(facility.pos, def.footprint);
      const occupied = new Set(tiles.map((tile) => tileKey(tile.x, tile.y)));
      state.facilities.splice(index, 1);
      for (const tile of tiles) {
        const key = tileKey(tile.x, tile.y);
        if (state.grid.facilityIndex[key] === facility.id) delete state.grid.facilityIndex[key];
      }
      state.vehicles = state.vehicles.filter(
        (vehicle) => !occupied.has(tileKey(vehicle.purpose.to.x, vehicle.purpose.to.y)),
      );
      state.money += Math.floor(def.cost * FACILITY.REFUND_RATIO);
      return ok;
    }
  }
}

/**
 * 置けるタイルだけに絞る。
 *
 * ドラッグが山や道路をかすめただけで操作全体が拒否されると、狙って避ける操作が
 * 要求されて煩わしい。プレビューはタイル単位で可否を出しているので、確定も
 * タイル単位で通す方が見た目と結果が一致する。
 */
function usableTiles(world: World, op: BuildOp & { tiles: TilePos[] }): TilePos[] {
  const { state } = world;
  return op.tiles.filter((t) => {
    if (terrainAt(state.grid, t.x, t.y) === undefined) return false;
    if (op.kind === 'buildRoad') return isBuildableTerrain(state.grid, t.x, t.y);
    if (op.kind === 'upgradeRoad') return roadRankAt(state.grid, t.x, t.y) === 1;
    if (op.kind === 'downgradeRoad') return roadRankAt(state.grid, t.x, t.y) === 2;
    if (op.kind === 'paintZone') {
      return (
        isBuildableTerrain(state.grid, t.x, t.y) &&
        terrainAt(state.grid, t.x, t.y) !== 'water' &&
        !hasRoad(state.grid, t.x, t.y)
      );
    }
    if (op.kind === 'demolishRoad') return hasRoad(state.grid, t.x, t.y);
    return true;
  });
}

/** applyOp と同じ検証。UI の可否表示から呼ぶ */
export function canApplyOp(world: World, op: BuildOp): OpResult {
  const { state } = world;
  switch (op.kind) {
    case 'buildRoad': {
      if (op.tiles.length === 0) return fail('タイルが指定されていない');
      const tiles = usableTiles(world, op);
      if (tiles.length === 0) return fail('ここには建設できない');
      if (!validateBridge(state.grid, tiles)) {
        return fail('橋は直線で、両端が陸に繋がっている必要がある');
      }
      // D8: 対象全体の合計費用を入口で検証し、足りなければ1タイルも変更しない。
      const cost = tiles.reduce(
        (sum, t) => sum + (hasRoad(state.grid, t.x, t.y) ? 0 : roadTileCost(state, t)),
        0,
      );
      if (cost > state.money) return fail('資金が足りない');
      return ok;
    }
    case 'upgradeRoad': {
      if (op.tiles.length === 0) return fail('タイルが指定されていない');
      const tiles = usableTiles(world, op);
      if (tiles.length === 0) return fail('ここには通常道路がない');
      if (tiles.length * ECONOMY.COST_UPGRADE_ROAD > state.money) {
        return fail('資金が足りない');
      }
      return ok;
    }
    case 'downgradeRoad': {
      const tiles = usableTiles(world, op);
      if (tiles.length === 0) return fail('ここには幹線道路がない');
      if (tiles.length * ECONOMY.COST_DOWNGRADE_ROAD > state.money) {
        return fail('資金が足りない');
      }
      return ok;
    }
    case 'demolishRoad': {
      const cost =
        op.tiles.filter((t) => hasRoad(state.grid, t.x, t.y)).length * ECONOMY.COST_DEMOLISH_ROAD;
      if (cost > state.money) return fail('資金が足りない');
      return ok;
    }
    case 'paintZone': {
      if (op.tiles.length === 0) return fail('タイルが指定されていない');
      const tiles = usableTiles(world, op);
      if (tiles.length === 0) return fail('ここには塗れない');
      const cost = tiles.reduce(
        (sum, t) => sum + (zoneAt(state.grid, t.x, t.y) === op.zone ? 0 : zoneTileCost(state, t)),
        0,
      );
      if (cost > state.money) return fail('資金が足りない');
      return ok;
    }
    case 'eraseZone':
      return ok;
    case 'demolishArea': {
      // 区画・建物の撤去は無料だが、道路を含む操作では道路撤去費を全額先払いする。
      // D8 により不足時は無料部分だけを先に消さず、操作全体を全か無かで拒否する。
      const tiles = usableTiles(world, op);
      const roadCount = tiles.filter((t) => hasRoad(state.grid, t.x, t.y)).length;
      const hasAnything = roadCount > 0 || tiles.some((t) => hasSomethingToClear(state, t));
      if (!hasAnything) return fail('ここには撤去するものがない');
      if (roadCount * ECONOMY.COST_DEMOLISH_ROAD > state.money) {
        return fail('資金が足りない');
      }
      return ok;
    }
    case 'buyDistrict': {
      if (hasChunk(state.grid, op.cx, op.cy)) return fail('すでに解放済み');
      if (!isAdjacentToOwned(state, op.cx, op.cy)) return fail('解放済みエリアに隣接していない');
      if (districtPrice(state) > state.money) return fail('資金が足りない');
      return ok;
    }
    case 'setIntersectionPriority':
      if (op.axis === null) return ok;
      return orthogonalIntersectionAt(state.grid, op.pos.x, op.pos.y)
        ? ok
        : fail('優先道路は孤立した直交のT字・十字交差点にのみ設定できる');
    case 'placeFacility': {
      const def = facilityDef(op.defId);
      if (!def) return fail('施設の定義が見つからない');
      if (def.unlock !== 'start' && !isUnlocked(state.progress.achievedMilestones, def.id)) {
        return fail('まだ解放されていない');
      }
      const tiles = facilityTiles(op.pos, def.footprint);
      let hasAccess = false;
      for (const tile of tiles) {
        const terrain = terrainAt(state.grid, tile.x, tile.y);
        if (terrain !== 'plain' && terrain !== 'forest') return fail('平地にのみ配置できる');
        if (hasRoad(state.grid, tile.x, tile.y)) return fail('道路と重なっている');
        if (buildingIdAt(state.grid, tile.x, tile.y) !== undefined) {
          return fail('建物と重なっている');
        }
        if (facilityIdAt(state.grid, tile.x, tile.y) !== undefined) {
          return fail('施設と重なっている');
        }
        if (hasRoadAccess(state.grid, tile.x, tile.y, ROAD.ROAD_ACCESS_DISTANCE)) {
          hasAccess = true;
        }
      }
      if (!hasAccess) return fail('道路へのアクセスがない');
      if (facilityPlacementCost(state, def.cost, tiles) > state.money) {
        return fail('資金が足りない');
      }
      return ok;
    }
    case 'removeFacility': {
      const facility = state.facilities.find((candidate) => candidate.id === op.id);
      if (!facility) return fail('施設が見つからない');
      return facilityDef(facility.defId) ? ok : fail('施設の定義が見つからない');
    }
  }
}

function facilityPlacementCost(
  state: GameState,
  baseCost: number,
  tiles: readonly TilePos[],
): number {
  const forestTiles = tiles.filter(
    (tile) => terrainAt(state.grid, tile.x, tile.y) === 'forest',
  ).length;
  return baseCost + forestTiles * ECONOMY.COST_CLEAR_FOREST;
}

function roadTileCost(state: GameState, t: TilePos): number {
  const kind = terrainAt(state.grid, t.x, t.y);
  if (kind === 'water') return ECONOMY.COST_BRIDGE;
  const base = ECONOMY.COST_ROAD;
  return kind === 'forest' ? base + ECONOMY.COST_CLEAR_FOREST : base;
}

function zoneTileCost(state: GameState, t: TilePos): number {
  const kind = terrainAt(state.grid, t.x, t.y);
  return ECONOMY.COST_ZONE + (kind === 'forest' ? ECONOMY.COST_CLEAR_FOREST : 0);
}

/** 森は建設・区画設定で更地になる（費用は別途 §9 で加算済み） */
function clearForest(state: GameState, t: TilePos): void {
  if (terrainAt(state.grid, t.x, t.y) === 'forest') {
    // setTerrain は grid.ts 経由。plain に戻す
    const { cx, cy } = toChunk(t.x, t.y);
    if (hasChunk(state.grid, cx, cy)) {
      const arr = state.grid.terrain[`${cx},${cy}`];
      if (arr) {
        const lx = t.x - cx * CS;
        const ly = t.y - cy * CS;
        arr[ly * CS + lx] = 0; // TERRAIN_CODE.plain
      }
    }
  }
}

/** エリア価格（実装書 §9）。開始チャンクは有償購入に数えない */
export function districtPrice(state: GameState): number {
  const purchased = state.districts.filter((d) => d.purchased).length;
  return Math.round(ECONOMY.DISTRICT_BASE_PRICE * ECONOMY.DISTRICT_PRICE_GROWTH ** purchased);
}

function isAdjacentToOwned(state: GameState, cx: number, cy: number): boolean {
  return state.districts.some((d) => Math.abs(d.cx - cx) + Math.abs(d.cy - cy) === 1);
}

/** 道路編集で対象形状ではなくなった交差点の設定・調停履歴を捨てる。 */
function pruneIntersectionState(state: GameState): void {
  const keys = new Set([
    ...Object.keys(state.intersectionPriorities ?? {}),
    ...Object.keys(state.intersectionLastServedAxes ?? {}),
    ...Object.keys(state.intersectionSignals ?? {}),
  ]);
  for (const key of keys) {
    const [xText, yText] = key.split(',');
    const x = Number(xText);
    const y = Number(yText);
    if (orthogonalIntersectionAt(state.grid, x, y)) continue;
    if (state.intersectionPriorities) delete state.intersectionPriorities[key];
    if (state.intersectionLastServedAxes) delete state.intersectionLastServedAxes[key];
    if (state.intersectionSignals) delete state.intersectionSignals[key];
  }
}

/**
 * 道路編集の近傍で新しく成立した交差点へ信号状態を作る。
 * 交差点判定は中心と8近傍しか見ないので、編集タイルの周囲1タイルだけで十分。
 */
function initializeIntersectionStateNear(state: GameState, changedTiles: readonly TilePos[]): void {
  const candidates = new Set<string>();
  for (const tile of changedTiles) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        candidates.add(tileKey(tile.x + dx, tile.y + dy));
      }
    }
  }
  // Set の挿入順は操作列で変わりうるため、保存オブジェクトの生成順も固定する。
  for (const key of [...candidates].sort()) {
    const [xText, yText] = key.split(',');
    const pos = { x: Number(xText), y: Number(yText) };
    if (orthogonalIntersectionAt(state.grid, pos.x, pos.y)) {
      ensureIntersectionSignal(state, pos);
    }
  }
}

/**
 * 撤去したタイル上の車は消す（実装書 §6）。
 * 失敗トリップには数えない（プレイヤーの操作による消滅なので、街の評価を下げない）。
 */
function removeVehiclesOnTiles(state: GameState, tiles: TilePos[]): void {
  const removed = new Set(tiles.map((t) => `${t.x},${t.y}`));
  state.vehicles = state.vehicles.filter((v) => v.path.every((p) => !removed.has(`${p.x},${p.y}`)));
}

/**
 * タイル上の区画と建物を消す（実装書 §12.4 W1-1・W1-3）。
 *
 * 道路建設で区画・建物の上を通ったとき、および撤去（`demolishArea`）で使う。
 * どちらも区画・建物の撤去自体は無料（呼び出し側で費用を取らない）。
 */
/** そのタイルに無料で消せるもの（区画または建物）があるか */
function hasSomethingToClear(state: GameState, t: TilePos): boolean {
  return (
    zoneAt(state.grid, t.x, t.y) !== null ||
    buildingIdAt(state.grid, t.x, t.y) !== undefined ||
    state.grid.facilityIndex[tileKey(t.x, t.y)] !== undefined
  );
}

/**
 * 矩形に触れている施設の id（重複なし・id 昇順）。
 *
 * **撤去ツールが施設を消せないと、置き直しができない。**
 * `removeFacility` op は最初から実装されているのに、UI からも撤去ツールからも
 * 一度も呼ばれていなかった（オーナー報告「施設が撤去できない」）。
 * 施設は「どこに置くか」を考えて置くものなので、**置き直せないのは致命的**。
 *
 * footprint 4 の施設は矩形が1タイルかすっただけでも丸ごと消える。
 * 半分だけ残す方が不自然なうえ、`facilityIndex` に半端な登録が残る。
 */
function facilityIdsTouching(state: GameState, tiles: readonly TilePos[]): number[] {
  const ids = new Set<number>();
  for (const t of tiles) {
    const id = state.grid.facilityIndex[tileKey(t.x, t.y)];
    if (id !== undefined) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

function clearZoneAndBuilding(state: GameState, t: TilePos): void {
  if (zoneAt(state.grid, t.x, t.y) !== null) setZone(state.grid, t.x, t.y, null);
  const buildingId = buildingIdAt(state.grid, t.x, t.y);
  if (buildingId !== undefined) removeBuilding(state, buildingId);
}

/**
 * 建物を1棟撤去する。`state.buildings` と `grid.buildingIndex` の両方から消し、
 * その建物を出発元・目的地にしている車も消す（存在しない建物へ向かい続けると
 * `applyTripSuccess` の `find` が毎tick空振りする）。
 * `removeVehiclesOnTiles`（道路撤去）と同じ方針で、失敗トリップには数えない
 * （プレイヤーの操作による消滅なので、街の評価を下げない）。
 */
function removeBuilding(state: GameState, buildingId: number): void {
  const idx = state.buildings.findIndex((b) => b.id === buildingId);
  if (idx < 0) return;
  const b = state.buildings[idx]!;
  state.buildings.splice(idx, 1);
  delete state.grid.buildingIndex[tileKey(b.pos.x, b.pos.y)];
  state.vehicles = state.vehicles.filter(
    (v) =>
      v.purpose.fromBuildingId !== b.id &&
      (v.purpose.to.x !== b.pos.x || v.purpose.to.y !== b.pos.y),
  );
}

/**
 * プレビュー用の可否判定（区画・矩形ドラッグ）。
 *
 * `canApplyOp` は BuildOp を組み立てて渡す設計で、矩形ドラッグ（最大 32×32 = 1024
 * タイル）だと `pointermove` ごとに 1024 個の BuildOp を使い捨てで作ることになる
 * （実装書 §4 W1-2）。D8 の全か無か方針に合わせ、対象全体の費用を先に合算する。
 * 払えない場合は有効な対象もすべて赤、払える場合だけ配置可能な対象をすべて緑にする。
 */
export function previewPaintZone(world: World, zone: ZoneType, tiles: TilePos[]): boolean[] {
  const { state } = world;
  const isValid = tiles.map(
    (t) =>
      terrainAt(state.grid, t.x, t.y) !== undefined &&
      isBuildableTerrain(state.grid, t.x, t.y) &&
      terrainAt(state.grid, t.x, t.y) !== 'water' &&
      !hasRoad(state.grid, t.x, t.y),
  );
  const cost = tiles.reduce((sum, t, i) => {
    if (!isValid[i] || zoneAt(state.grid, t.x, t.y) === zone) return sum;
    return sum + zoneTileCost(state, t);
  }, 0);
  const affordable = cost <= state.money;
  return isValid.map((valid) => valid && affordable);
}

/**
 * プレビュー用の可否判定（道路・直線ドラッグ）。
 *
 * D8 により道路建設も全か無か。**タイルごとの費用が一定でない**
 * （道路10 / 橋50 / 森は+5）ため、対象全体の実費を合算し、足りなければ
 * 配置可能なタイルも含めてすべて赤にする。
 *
 * 橋の直線制約（`validateBridge`）は集合全体に対する判定なので、ここでは扱わない。
 * 確定時に `canApplyOp` が弾き、理由がトーストに出る。
 */
export function previewBuildRoad(world: World, tiles: TilePos[]): boolean[] {
  const { state } = world;
  const isValid = tiles.map((t) =>
    Boolean(
      terrainAt(state.grid, t.x, t.y) !== undefined && isBuildableTerrain(state.grid, t.x, t.y),
    ),
  );
  const cost = tiles.reduce((sum, t, i) => {
    if (!isValid[i] || hasRoad(state.grid, t.x, t.y)) return sum;
    return sum + roadTileCost(state, t);
  }, 0);
  const affordable = cost <= state.money;
  return isValid.map((valid) => valid && affordable);
}

/** 施設配置プレビュー。footprint 全体を、実適用と同じ全か無かで返す。 */
export function previewPlaceFacility(world: World, defId: string, pos: TilePos): boolean[] {
  const def = facilityDef(defId);
  if (!def) return [];
  const tiles = facilityTiles(pos, def.footprint);
  const valid = canApplyOp(world, { kind: 'placeFacility', defId, pos }).ok;
  return tiles.map(() => valid);
}

/**
 * プレビュー用の可否判定（幹線化。`docs/m4-trace-design.md` T7 §2/§3）。
 *
 * 「幹線」は道路の無いタイルにも1回のドラッグで引ける仕様で、`commitDrag` 側は
 * `buildRoad` → `upgradeRoad` の2opを同じタイル列へ続けて出す（1op目が消費した
 * 残高で2op目の予算が変わる）。プレビューを「通常道路の費用のまま」出すと、
 * 指を離した瞬間に通常道路の新設費を大幅に上回る合成費用
 * （`COST_ROAD + COST_UPGRADE_ROAD`）を取られる
 * ことになる（設計書の警告そのもの）ので、ここも2op分をこの順で追う。
 *
 * 道路新設と幹線化の合計費用を先に求め、合成操作全体を緑か赤の一方に揃える。
 * 既に幹線（ランク2）のタイルは `usableTiles` の `upgradeRoad` フィルタ
 * （ランク1のみ対象）に引っかからず無料で素通りするので、ここでも無条件で有効にする。
 */
export function previewUpgradeRoad(world: World, tiles: TilePos[]): boolean[] {
  const { state } = world;
  const isValid = tiles.map(
    (t) =>
      terrainAt(state.grid, t.x, t.y) !== undefined && isBuildableTerrain(state.grid, t.x, t.y),
  );
  const cost = tiles.reduce((sum, t, i) => {
    if (!isValid[i]) return sum;
    if (roadRankAt(state.grid, t.x, t.y) === 2) return sum;
    const buildCost = hasRoad(state.grid, t.x, t.y) ? 0 : roadTileCost(state, t);
    return sum + buildCost + ECONOMY.COST_UPGRADE_ROAD;
  }, 0);
  const affordable = cost <= state.money;
  return isValid.map((valid) => valid && affordable);
}

/**
 * プレビュー用の可否判定（縮小＝ `downgradeRoad`。T7 §3/§4）。
 *
 * `downgradeRoad` も他の有料編集操作と同じく**全か無か**——`canApplyOp` が
 * 対象タイル全体ぶんの費用を一括で見て、通らなければ `applyOp` 本体はまったく走らない
 * （`applyOp` の `downgradeRoad` 節は予算チェックをせず、通った後は全タイルを下げ切る）。
 * したがってプレビューを「途中から赤くなる」形にしてはいけない。実際の結果は
 * 「対象タイルが全部下がる」か「1枚も下がらない」かのどちらかしかないので、
 * 対象（幹線）タイルは全体が払えるときだけ緑、そうでなければ全部赤にする。
 *
 * 非対象タイル（通常道路・更地）は常に赤——これがそのまま T7 §4 の
 * 「対象になる幹線タイルだけをハイライトする」を満たす。
 */
export function previewDowngradeRoad(world: World, tiles: TilePos[]): boolean[] {
  const { state } = world;
  const isTarget = tiles.map((t) => roadRankAt(state.grid, t.x, t.y) === 2);
  const targetCount = isTarget.filter(Boolean).length;
  const affordable = targetCount * ECONOMY.COST_DOWNGRADE_ROAD <= state.money;
  return isTarget.map((target) => target && affordable);
}

/**
 * プレビュー用の可否判定（撤去・矩形ドラッグ）。道路撤去費を全対象ぶん合算し、
 * 足りなければ無料の区画・建物を含む矩形全体を赤にする（D8 の全か無か方針）。
 */
export function previewDemolishArea(world: World, tiles: TilePos[]): boolean[] {
  const { state } = world;
  const isValid = tiles.map((t) => terrainAt(state.grid, t.x, t.y) !== undefined);
  const roadCount = tiles.reduce(
    (count, t, i) => count + (isValid[i] && hasRoad(state.grid, t.x, t.y) ? 1 : 0),
    0,
  );
  const affordable = roadCount * ECONOMY.COST_DEMOLISH_ROAD <= state.money;
  return isValid.map((valid) => valid && affordable);
}

/** 道路アクセス距離（実装書 §8.2）。M2 の入居判定で使う */
export const ROAD_ACCESS_DISTANCE = ROAD.ROAD_ACCESS_DISTANCE;
