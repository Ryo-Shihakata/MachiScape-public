/**
 * 交通シミュレーション（実装書 §7）。
 *
 * 車は個別のエージェントとして道路上を走り、渋滞は「タイルごとの在車数」から
 * 自然に発生する（渋滞そのものを直接モデル化しない）。
 *
 * トリップの発生源は建物（住宅→商業/工業の人流、工業→商業の物流）。
 * 建物が1棟も無い間はダミートリップで道路の動作確認だけを行う。
 */

import { GROWTH, ROAD, SPACE, TIME, TRAFFIC } from '../balance';
import { satisfactionFloorAt } from '../facility';
import { hasArterialRoad, hasRoad } from '../grid';
import type { Rng } from '../rng';
import { congestionAt, updateCongestion, type CongestionMap } from '../road/congestion';
import {
  approachAxis,
  orthogonalIntersectionAt,
  type OrthogonalIntersection,
} from '../road/intersection';
import { findPath, pathCost } from '../road/pathfind';
import type {
  GameState,
  Grid,
  IntersectionAxis,
  RoadRank,
  TilePos,
  Vehicle,
  VehiclePhase,
} from '../types';
import { applyTripSuccess, deliverCargo, spawnPeopleTrips } from './trips';
import {
  ensureIntersectionSignal,
  intersectionAxisCanEnter,
  intersectionSignalAt,
  minimumGreenTicks,
} from './signal';

export * from './trips';
export * from './signal';
export * from './trace';

const DT_SECONDS = 1 / TIME.TICKS_PER_SECOND;

/** 辺の長さ。斜めは √2（経路探索のコストと揃える） */
function edgeLength(a: TilePos, b: TilePos): number {
  return a.x !== b.x && a.y !== b.y ? Math.SQRT2 : 1;
}

/** 現在の脚で出発する建物。復路では往路の目的地が出発点になる。 */
function legOrigin(v: Vehicle): TilePos {
  return v.leg === 'outbound' ? v.purpose.from : v.purpose.to;
}

/** 現在の脚で入る建物。復路では往路の出発元へ戻る。 */
function legDestination(v: Vehicle): TilePos {
  return v.leg === 'outbound' ? v.purpose.to : v.purpose.from;
}

/** 建物中心とアクセス道路タイル中心の実距離（タイル単位）。 */
function accessDistance(v: Vehicle, phase: 'exiting' | 'entering'): number {
  const building = phase === 'exiting' ? legOrigin(v) : legDestination(v);
  const road = phase === 'exiting' ? v.path[0] : v.path[v.path.length - 1];
  return road ? Math.hypot(road.x - building.x, road.y - building.y) : 0;
}

/** ACCESS_SPEED を実距離で正規化し、アクセス区間を1tick進める。 */
function advanceAccess(v: Vehicle, phase: 'exiting' | 'entering'): void {
  const distance = accessDistance(v, phase);
  v.accessProgress =
    distance > 0
      ? Math.min(1, v.accessProgress + (TRAFFIC.ACCESS_SPEED * DT_SECONDS) / distance)
      : 1;
}

function tileKeyOf(x: number, y: number): string {
  return `${x},${y}`;
}

/** 1tick ぶん交通を進める。world.ts が毎tick1回だけ呼ぶ */
export function stepTraffic(state: GameState, congestion: CongestionMap, rng: Rng): void {
  // spawn と迂回は同じ総予算を消費する。迂回を先に最大1枠だけ処理しても、
  // spawn には従来と同じ最大4枠が残るため、総 A* 回数は必ず上限以下になる。
  const pathfindBudget = { remaining: ROAD.PATHFIND_BUDGET_PER_TICK };
  rerouteStuckVehicles(state, congestion, pathfindBudget);
  const budget = {
    remaining: Math.min(ROAD.SPAWN_PATHFIND_BUDGET_PER_TICK, pathfindBudget.remaining),
  };

  // 物流は日次（stepDay から呼ぶ）。ここで呼ぶと1日600回要求してしまう
  //
  // **ダミートリップ（建物が無い間だけ道路上をランダムに走る車）は廃止した。**
  // M1 では「建物がまだ無くても道が動いて見える」ための足場として要ったが、
  // 建物が建つようになった今は次の実害しかない:
  //  - どの建物とも関係なく湧いて、どこへも行かずに消える「幽霊自動車」に見える
  //    （往復トリップを入れて以降は、道路の途中で滞在してから引き返す動きになる）
  //  - 経路が見つからない場合を失敗として計上するため、道路だけ大量に敷いた状態で
  //    失敗率が跳ね上がり、需要が潰れて街が育たなくなる（実測で再現済み）
  spawnPeopleTrips(state, congestion, rng, budget);

  const arterial = hasArterialRoad(state.grid);
  // 建物アクセスを進め、道路端まで来た合流候補を追従計画へ渡す。同じ全車走査で
  // 道路占有も数え、1500台時に合流対応だけの走査を増やさない。
  const occ: OccupancyMap = new Map();
  const mergeCandidates = prepareRoadEntries(state, occ);
  moveVehicles(state, occ, arterial, mergeCandidates);
  updateCongestion(congestion, occupancyRecord(occ), arterial ? state.grid : undefined);
}

/**
 * 明らかに遅れている車だけを、固定順・固定予算で再探索する。
 *
 * 判定tick自体を間引き、失敗した探索にもクールダウンを付けることで、混雑を即座に
 * 解消する「賢すぎるAI」にはしない。戻り値は実際に行った A* の回数。
 */
export function rerouteStuckVehicles(
  state: GameState,
  congestion: CongestionMap,
  pathfindBudget: { remaining: number },
): number {
  if (state.tick % ROAD.REROUTE_CHECK_INTERVAL_TICKS !== 0) return 0;

  // 混雑度は車ごとに1回だけ測る。
  // ここは判定tickに**全車**を走査する唯一の場所で、`congestionAt` はタイルごとに
  // 文字列キーを作るため、測り直すと台数×経路長ぶんの文字列生成が積み上がる
  // （実測: 測り直す実装では 1500台で 2.40 → 3.16 ms/tick まで悪化した）
  const candidates: Array<{ v: Vehicle; congestion: number }> = [];
  for (const v of state.vehicles) {
    if (v.phase !== 'road') continue;
    if (state.tick - v.legStartedTick <= ROAD.TICKS_STUCK) continue;
    if (
      v.lastRerouteTick !== undefined &&
      state.tick - v.lastRerouteTick < ROAD.REROUTE_COOLDOWN_TICKS
    ) {
      continue;
    }
    const c = remainingCongestion(v, congestion);
    if (c < ROAD.REROUTE_CONGESTION_THRESHOLD) continue;
    const candidate = { v, congestion: c };
    let index = 0;
    while (
      index < candidates.length &&
      compareRerouteCandidates(candidates[index]!, candidate) <= 0
    ) {
      index++;
    }
    if (index < ROAD.REROUTE_BUDGET_PER_TICK) {
      candidates.splice(index, 0, candidate);
      if (candidates.length > ROAD.REROUTE_BUDGET_PER_TICK) candidates.pop();
    }
  }

  // **混雑がひどい順**の予算件数だけを上の走査中に残す。全候補を並べ替えると、
  // 予算1台のために1500台を sort することになる。同点は id 昇順の固定全順序。

  let attempts = 0;
  for (const { v } of candidates) {
    if (attempts >= ROAD.REROUTE_BUDGET_PER_TICK || pathfindBudget.remaining <= 0) break;

    // 現在の辺は既に走行中なので、その終点から先だけを探索する。これにより
    // edgeProgress を保ったまま、画面上の車が別の辺へ瞬間移動するのを防げる。
    const next = v.path[v.edgeIndex + 1];
    const destination = v.path[v.path.length - 1];
    if (!next || !destination) continue;
    if (next.x === destination.x && next.y === destination.y) continue;

    v.lastRerouteTick = state.tick;
    attempts++;
    pathfindBudget.remaining--;
    const newSuffix = findPath(state.grid, congestion, next, destination);
    if (!newSuffix) continue;

    const currentSuffix = v.path.slice(v.edgeIndex + 1);
    const currentCost = pathCost(congestion, currentSuffix);
    const newCost = pathCost(congestion, newSuffix);
    if (currentCost <= 0) continue;
    const improvement = (currentCost - newCost) / currentCost;
    if (improvement < ROAD.REROUTE_MIN_IMPROVEMENT) continue;

    /**
     * 走行済みの接頭辞と現在の辺を残し、次タイル以降だけを置き換える。
     * edgeIndex / edgeProgress を保てるうえ、往路では経路先頭（元の出発地）も残る。
     * したがって到着後の `reverse()` は迂回後の全往路を逆走し、必ず元へ戻る。
     */
    v.path = v.path.slice(0, v.edgeIndex + 1).concat(newSuffix);
  }
  return attempts;
}

function compareRerouteCandidates(
  a: { v: Vehicle; congestion: number },
  b: { v: Vehicle; congestion: number },
): number {
  return b.congestion !== a.congestion ? b.congestion - a.congestion : a.v.id - b.v.id;
}

/** タイルごとの在車数。渋滞の元になる唯一の入力 */
export function countOccupancy(state: GameState): Record<string, number> {
  const occ: Record<string, number> = {};
  for (const v of state.vehicles) {
    // 私道上の車を道路の混雑・容量へ混ぜない。path は道路タイル列のまま保つ。
    if (v.phase !== 'road') continue;
    const tile = v.path[v.edgeIndex];
    if (!tile) continue;
    const k = tileKeyOf(tile.x, tile.y);
    occ[k] = (occ[k] ?? 0) + 1;
  }
  return occ;
}

/** 車を進める。到着・タイムアウトした車は取り除く */
function moveVehicles(
  state: GameState,
  occ: OccupancyMap,
  hasArterial: boolean,
  mergeCandidates: Vehicle[],
): void {
  const survivors: Vehicle[] = [];

  const plan = planVehicleMovements(state, occ, hasArterial, mergeCandidates);
  const movements = plan.movements;
  for (const movement of movements) {
    movement.vehicle.edgeProgress += movement.delta;
  }

  for (const v of state.vehicles) {
    if (v.phase === 'dwell') {
      survivors.push(v);
      continue;
    }

    if (v.phase === 'exiting') {
      const accessRoad = v.path[0];
      if (!accessRoad || !hasRoad(state.grid, accessRoad.x, accessRoad.y)) {
        timeout(state, v);
        continue;
      }
      if (state.tick - v.legStartedTick > TRAFFIC.TRIP_TIMEOUT) {
        timeout(state, v);
        continue;
      }
      survivors.push(v);
      continue;
    }

    if (v.phase === 'entering') {
      advanceAccess(v, 'entering');
      if (v.accessProgress >= 1) {
        if (arrive(state, v)) survivors.push(v);
        continue;
      }
      if (state.tick - v.legStartedTick > TRAFFIC.TRIP_TIMEOUT) {
        timeout(state, v);
        continue;
      }
      survivors.push(v);
      continue;
    }

    const cur = v.path[v.edgeIndex];
    const nextTile = v.path[v.edgeIndex + 1];
    if (!cur || !nextTile) {
      v.phase = 'entering';
      v.accessProgress = 0;
      survivors.push(v);
      continue;
    }
    // 道路存在は移動計画時に確認済み。撤去を検出した車だけを集合で受け取ることで、
    // 正常な1500台について同じ道路ランクをこの2回目の全車走査で読み直さない。
    if (plan.invalidRoadVehicleIds?.has(v.id)) {
      timeout(state, v);
      continue;
    }

    while (v.edgeProgress >= 1) {
      v.edgeProgress -= 1;
      v.edgeIndex++;
      if (v.edgeIndex >= v.path.length - 1) break;
    }

    if (v.edgeIndex >= v.path.length - 1) {
      // 道路の終端へ着いた時点ではまだ到着ではない。ここから建物までを低速で進む。
      v.phase = 'entering';
      v.accessProgress = 0;
      v.edgeProgress = 0;
      survivors.push(v);
      continue;
    }

    if (state.tick - v.legStartedTick > TRAFFIC.TRIP_TIMEOUT) {
      timeout(state, v);
      continue;
    }

    survivors.push(v);
  }
  state.vehicles = survivors;
}

interface PlannedMovement {
  vehicle: Vehicle;
  cur: TilePos;
  next: TilePos;
  /**
   * 有向辺を表す1つの数値キー。並べ替えの比較を「数値1回」にするために持つ。
   *
   * 座標4つを順に比べる比較関数は、車1,500台の並べ替えで1万数千回呼ばれ、
   * 実測で 2.44 → 3.59 ms/tick まで悪化した（予算は5ms）。
   * 隣接タイルは8方向のいずれかなので、方向を3ビットに畳んで1つの数値に詰められる。
   */
  edgeKey: number;
  /** 幹線の2本の論理レーン。通常道路では常に0。 */
  lane: 0 | 1;
  /** 並べ替え中に車を動かしても比較値が変わらないよう、tick 開始時の値を保持する */
  progress: number;
  /** 同じ有向辺の中での位置（進捗の降順）。直前の車を O(1) で引くために持つ */
  indexInEdge: number;
  desiredDelta: number;
  delta: number;
}

interface LeaderDistance {
  leader: PlannedMovement;
  distance: number;
}

interface MovementPlan {
  movements: PlannedMovement[];
  /** 探索済み経路の道路がプレイヤー操作で消えていた車。通常は未生成。 */
  invalidRoadVehicleIds?: Set<number>;
}

/** 座標の負値を避けるための下駄。チャンク購入で広がる範囲を十分に超える */
const EDGE_KEY_BIAS = 1 << 15;
const EDGE_KEY_STRIDE = 1 << 16;

/** tick内の道路占有数。数値キーで車両ごとの文字列生成を避ける。 */
type OccupancyMap = Map<number, number>;

/** 有向辺（始点タイル + 進行方向）を1つの数値にする。2^35 未満なので倍精度で正確に扱える */
function directedEdgeKey(cur: TilePos, next: TilePos): number {
  const tile = tileNumberKey(cur.x, cur.y);
  // 方向は 8 通り（dx, dy はそれぞれ -1..1）
  const dir = (next.x - cur.x + 1) * 3 + (next.y - cur.y + 1);
  return tile * 9 + dir;
}

/** 1tick内のランク参照でチャンクキー文字列を繰り返し生成しないための読み取りキャッシュ。 */
class TrafficRoadReader {
  private chunks = new Map<number, Uint8Array | undefined>();

  constructor(private grid: Grid) {}

  rank(x: number, y: number): RoadRank {
    const cx = Math.floor(x / SPACE.CHUNK_SIZE);
    const cy = Math.floor(y / SPACE.CHUNK_SIZE);
    const key = cx * EDGE_KEY_STRIDE + cy;
    let arr = this.chunks.get(key);
    if (arr === undefined && !this.chunks.has(key)) {
      arr = this.grid.road[`${cx},${cy}`];
      this.chunks.set(key, arr);
    }
    if (!arr) return 0;
    const lx = x - cx * SPACE.CHUNK_SIZE;
    const ly = y - cy * SPACE.CHUNK_SIZE;
    const rank = arr[ly * SPACE.CHUNK_SIZE + lx] ?? 0;
    return rank === 2 ? 2 : rank === 1 ? 1 : 0;
  }
}

function edgeRoadRank(road: TrafficRoadReader, cur: TilePos, next: TilePos): 1 | 2 {
  // 両端が幹線の辺だけを2レーンにする。狭窄部へ入る辺は事前に1レーンへ合流する。
  return road.rank(cur.x, cur.y) === 2 && road.rank(next.x, next.y) === 2 ? 2 : 1;
}

/**
 * 車両の論理レーンを決める唯一の規則。
 *
 * 幹線では車 id の偶数を内側レーン(0)、奇数を外側レーン(1)へ固定する。
 * id は決定論的な連番なので、シード・操作列が同じなら割り当ても必ず同じになる。
 * 追越しや車線変更は行わず、通常道路および幹線の端では全車がレーン0へ合流する。
 */
export function logicalLaneIndex(vehicleId: number, rank: RoadRank): 0 | 1 {
  return rank === 2 && (vehicleId & 1) === 1 ? 1 : 0;
}

function edgeLaneKey(edgeKey: number, lane: 0 | 1): number {
  return edgeKey * 2 + lane;
}

/** タイル座標を衝突しない数値へ詰める。交差点のtick内キャッシュにも使う。 */
function tileNumberKey(x: number, y: number): number {
  return (x + EDGE_KEY_BIAS) * EDGE_KEY_STRIDE + (y + EDGE_KEY_BIAS);
}

/** 混雑度マップの保存キーへ、占有タイルごとに1回だけ変換する。 */
function occupancyRecord(occupancy: OccupancyMap): Record<string, number> {
  const record: Record<string, number> = {};
  for (const [key, count] of occupancy) {
    const biasedX = Math.floor(key / EDGE_KEY_STRIDE);
    const biasedY = key - biasedX * EDGE_KEY_STRIDE;
    record[tileKeyOf(biasedX - EDGE_KEY_BIAS, biasedY - EDGE_KEY_BIAS)] = count;
  }
  return record;
}

/**
 * 同じ有向辺の車を前から並べ、前車のこの tick の予定位置を越えない移動量を作る。
 *
 * 有向辺の座標、進捗、id の順に全順序を作るため、入力配列やオブジェクトのキー順に
 * 結果が左右されない。前から移動量を確定するため、先頭の減速は後続へ1台ずつ伝わる。
 */
function planVehicleMovements(
  state: GameState,
  occ: OccupancyMap,
  hasArterial: boolean,
  mergeCandidates: Vehicle[],
): MovementPlan {
  const movements: PlannedMovement[] = [];
  let invalidRoadVehicleIds: Set<number> | undefined;
  const mergeMovements = new Map<number, PlannedMovement>();
  const road = hasArterial ? new TrafficRoadReader(state.grid) : null;
  for (const vehicle of state.vehicles) {
    if (vehicle.phase !== 'road') continue;
    const cur = vehicle.path[vehicle.edgeIndex];
    const next = vehicle.path[vehicle.edgeIndex + 1];
    if (
      cur &&
      next &&
      (!hasRoad(state.grid, cur.x, cur.y) || !hasRoad(state.grid, next.x, next.y))
    ) {
      (invalidRoadVehicleIds ??= new Set()).add(vehicle.id);
      continue;
    }
    const movement = plannedMovement(vehicle, road, occ);
    if (movement) movements.push(movement);
  }
  // 合流候補も同じ固定順の配列へ先に加える。下で不成立車を除くので、通常追従や
  // 交差点制御には道路へ出られた候補だけが残る。
  for (const vehicle of mergeCandidates) {
    const movement = plannedMovement(vehicle, road, occ);
    if (movement) {
      movements.push(movement);
      mergeMovements.set(vehicle.id, movement);
    }
  }

  movements.sort((a, b) => {
    if (a.edgeKey !== b.edgeKey) return a.edgeKey - b.edgeKey;
    if (road && a.lane !== b.lane) return a.lane - b.lane;
    if (a.progress !== b.progress) return b.progress - a.progress;
    return a.vehicle.id - b.vehicle.id;
  });

  // 有向辺ごとの索引（各辺は進捗の降順＝先頭の車から並ぶ）。
  // 辺をまたいで前車を探すために要る
  // `movements` は (edgeKey, 進捗降順, id昇順) に整列済みなので、
  // 各辺のリストも自然に「先頭の車から」並ぶ。
  // **自分の直前の要素がそのまま前車**になるので、探索は O(1) で済む
  // （辺ごとに線形走査すると、1つの辺に車が集まったとき O(k²) になり、
  //  実測で 2.6 → 9.3 ms/tick まで悪化した）。
  const byEdge = new Map<number, PlannedMovement[]>();
  for (const m of movements) {
    if (m.vehicle.phase !== 'road') continue;
    const key = road ? edgeLaneKey(m.edgeKey, m.lane) : m.edgeKey;
    const list = byEdge.get(key);
    if (list) {
      m.indexInEdge = list.length;
      list.push(m);
    } else {
      m.indexInEdge = 0;
      byEdge.set(key, [m]);
    }
  }

  // **交差点停止・追従より先に合流を確定する。** 同じ byEdge を再利用するため、
  // 合流のためだけに全道路車をもう一度整列・索引化するコストも発生しない。
  resolveRoadEntries(state, occ, road, mergeCandidates, mergeMovements, movements, byEdge);
  let activeCount = 0;
  for (const movement of movements) {
    if (movement.vehicle.phase === 'road') movements[activeCount++] = movement;
  }
  movements.length = activeCount;

  // **交差点の停止を先に確定させる。**
  // 以前は追従を先に計算していたため、後続車は「先頭車が交差点で止まる前の
  // 大きめの移動量」を基準にしてしまい、同じtick内で急停止が伝播しなかった。
  applyIntersectionConflicts(state, movements);

  // 追従を2周かける。1周目で先頭付近が確定し、2周目でその減速が後ろへ伝わる。
  // 完全な収束（列の長さぶんの伝播）は狙わない——シミュは10tick/秒なので、
  // 残りは次tickで伝わる。回数を固定することで1tickの計算量が一定になる。
  for (let pass = 0; pass < FOLLOWING_PASSES; pass++) {
    for (const m of movements) {
      const leader = distanceToLeader(road, m, byEdge);
      if (leader === null) continue;
      const available = leader.distance - TRAFFIC.MIN_HEADWAY_DISTANCE;
      // 距離（タイル）を、この辺での進捗の増分に直す
      const maxDelta = Math.max(0, available / edgeLength(m.cur, m.next));
      m.delta = Math.min(m.desiredDelta, m.delta, maxDelta);
    }
  }
  return { movements, invalidRoadVehicleIds };
}

/** 追従の伝播をかける回数（`planVehicleMovements` の説明を参照） */
const FOLLOWING_PASSES = 2;

/**
 * 前車までの**経路に沿った距離**（タイル単位）。前車がいなければ null。
 *
 * **同じ辺の車だけを見てはいけない。** 以前は同一の有向辺に限っていたため、
 * 1タイル後ろにいる先行車には車間の制約がまったく効かず、交差点の手前で
 * 列が複数タイルにまたがると車が重なった（オーナー報告のスクリーンショットそのもの）。
 *
 * 探索は「自分の経路の先の辺」を `HEADWAY_LOOKAHEAD_EDGES` 本まで辿る。
 * 前車が見つかるか、車間の制約が効きえない距離まで離れたら打ち切るので、
 * 1台あたりの計算量は一定に保たれる（全車ペアの比較はしない）。
 */
function distanceToLeader(
  road: TrafficRoadReader | null,
  m: PlannedMovement,
  byEdge: Map<number, PlannedMovement[]>,
): LeaderDistance | null {
  // 1) まず自分と同じ辺の直前の車。リストは進捗の降順なので配列の1つ手前がそれ。
  //    同じ進捗に並んだ車は整列時に id 昇順で割ってあるので、ここも決定論的に決まる
  const sameEdge = byEdge.get(road ? edgeLaneKey(m.edgeKey, m.lane) : m.edgeKey);
  if (sameEdge && m.indexInEdge > 0) {
    const best = sameEdge[m.indexInEdge - 1] as PlannedMovement;
    return {
      leader: best,
      distance: (best.progress - m.progress) * edgeLength(m.cur, m.next),
    };
  }

  // 2) 見つからなければ、自分の経路の先の辺を順に見る
  const path = m.vehicle.path;
  // 自分がこの辺で残している距離
  let accumulated = (1 - m.progress) * edgeLength(m.cur, m.next);
  const maxScan = TRAFFIC.MIN_HEADWAY_DISTANCE + m.desiredDelta * edgeLength(m.cur, m.next) + 1;

  for (let i = 1; i <= TRAFFIC.HEADWAY_LOOKAHEAD_EDGES; i++) {
    if (accumulated > maxScan) return null;
    const a = path[m.vehicle.edgeIndex + i];
    const b = path[m.vehicle.edgeIndex + i + 1];
    if (!a || !b) return null;
    const len = edgeLength(a, b);
    const edgeKey = directedEdgeKey(a, b);
    const lane = road ? logicalLaneIndex(m.vehicle.id, edgeRoadRank(road, a, b)) : 0;
    const list = byEdge.get(road ? edgeLaneKey(edgeKey, lane) : edgeKey);
    if (list && list.length > 0) {
      // 進捗の降順に並んでいるので、末尾がその辺のいちばん後ろの車＝自分の前車
      const rear = list[list.length - 1] as PlannedMovement;
      return { leader: rear, distance: accumulated + rear.progress * len };
    }
    accumulated += len;
  }
  return null;
}

/** 建物アクセスを進め、この tick に道路端で合流を要求する車を返す。 */
function prepareRoadEntries(state: GameState, occ: OccupancyMap): Vehicle[] {
  const candidates: Vehicle[] = [];
  for (const v of state.vehicles) {
    // 滞在を終えた車は、この tick から復路の exiting として扱う。同じ走査の後半で
    // そのままアクセスも進め、1500台時に全車走査を1回余分に増やさない。
    if (v.phase === 'dwell' && v.dwellUntilTick !== null && state.tick >= v.dwellUntilTick) {
      // 復路は往路で探索済みの経路を反転する。ここで A* は実行しない。
      v.path.reverse();
      v.edgeIndex = 0;
      v.edgeProgress = 0;
      v.leg = 'return';
      v.legStartedTick = state.tick;
      v.dwellUntilTick = null;
      v.phase = 'exiting';
      v.accessProgress = 0;
      delete v.mergeWaitSinceTick;
    }
    if (v.phase === 'road') {
      const tile = v.path[v.edgeIndex];
      if (tile) {
        const key = tileNumberKey(tile.x, tile.y);
        occ.set(key, (occ.get(key) ?? 0) + 1);
      }
      continue;
    }
    if (v.phase !== 'exiting') continue;
    const accessRoad = v.path[0];
    const nextRoad = v.path[1];
    if (
      !accessRoad ||
      !nextRoad ||
      !hasRoad(state.grid, accessRoad.x, accessRoad.y) ||
      !hasRoad(state.grid, nextRoad.x, nextRoad.y)
    ) {
      continue;
    }
    if (v.accessProgress < 1) advanceAccess(v, 'exiting');
    if (v.accessProgress < 1) continue;
    v.mergeWaitSinceTick ??= state.tick;
    candidates.push(v);
  }
  if (candidates.length === 0) return candidates;

  // 同時要求は車両配列の順序に依存させない。id は決定論的な連番である。
  candidates.sort((a, b) => a.id - b.id);
  return candidates;
}

/**
 * 通常追従が作った有向辺索引を使い、合流を id 昇順で確定する。
 *
 * ギャップ判定は追従と同じ `distanceToLeader` なので、辺境界をまたいだ物理距離で
 * 前後を測る。最大待機後だけは飢餓防止を優先し、後続の追従停止に任せて合流する。
 */
function resolveRoadEntries(
  state: GameState,
  occ: OccupancyMap,
  road: TrafficRoadReader | null,
  candidates: Vehicle[],
  candidateMovements: Map<number, PlannedMovement>,
  movements: PlannedMovement[],
  byEdge: Map<number, PlannedMovement[]>,
): void {
  if (candidates.length === 0) return;

  const approachingByEdge = new Map<number, PlannedMovement[]>();
  const candidateAccessRoads = new Set<number>();
  for (const movement of candidateMovements.values()) {
    candidateAccessRoads.add(tileNumberKey(movement.cur.x, movement.cur.y));
  }

  for (const movement of movements) {
    const v = movement.vehicle;
    if (v.phase !== 'road') continue;
    // 必要ギャップ内の後続になり得るのは、現在の辺の終点がいずれかの合流点である
    // 車だけ。大半の車はこの座標チェックだけで除外し、幹線ランク参照を行わない。
    if (!candidateAccessRoads.has(tileNumberKey(movement.next.x, movement.next.y))) continue;

    // 必要ギャップは最短の道路辺（1タイル）より短いため、合流点から必要距離内に
    // いる後続車は、必ず「次に合流先の辺へ入る車」のどれかである。全車を候補ごとに
    // 再走査せず、次の辺だけを逆引きして高負荷時の計算量を O(車両+合流要求) に保つ。
    const futureCur = v.path[v.edgeIndex + 1];
    const futureNext = v.path[v.edgeIndex + 2];
    if (!futureCur || !futureNext) continue;
    const futureEdgeKey = directedEdgeKey(futureCur, futureNext);
    const futureLane = road ? logicalLaneIndex(v.id, edgeRoadRank(road, futureCur, futureNext)) : 0;
    const futureKey = road ? edgeLaneKey(futureEdgeKey, futureLane) : futureEdgeKey;
    const approaching = approachingByEdge.get(futureKey);
    if (approaching) approaching.push(movement);
    else approachingByEdge.set(futureKey, [movement]);
  }

  // 同じアクセス道路へ同じ tick に入れるのは1台だけ。最大待機済みの車が複数いても
  // id の小さい車から1 tickずつ確実に出し、同位置への重なりを作らない。
  const mergedAccessRoads = new Set<number>();
  for (const vehicle of candidates) {
    const movement = candidateMovements.get(vehicle.id);
    const accessRoad = vehicle.path[0];
    if (!movement || !accessRoad) continue;
    const accessKey = tileNumberKey(accessRoad.x, accessRoad.y);
    if (mergedAccessRoads.has(accessKey)) continue;

    insertIndexedMovement(road, movement, byEdge);

    const front = distanceToLeader(road, movement, byEdge);
    const movementKey = road ? edgeLaneKey(movement.edgeKey, movement.lane) : movement.edgeKey;
    const hasGapAhead = front === null || front.distance >= TRAFFIC.MERGE_GAP_DISTANCE;
    let hasGapBehind = true;
    for (const rear of approachingByEdge.get(movementKey) ?? []) {
      const leader = distanceToLeader(road, rear, byEdge);
      if (leader?.leader === movement && leader.distance < TRAFFIC.MERGE_GAP_DISTANCE) {
        hasGapBehind = false;
        break;
      }
    }

    const waited = state.tick - (vehicle.mergeWaitSinceTick ?? state.tick);
    const starved = waited >= TRAFFIC.MERGE_MAX_WAIT_TICKS;
    if ((!hasGapAhead || !hasGapBehind) && !starved) {
      removeIndexedMovement(road, movement, byEdge);
      continue;
    }

    vehicle.phase = 'road';
    vehicle.accessProgress = 0;
    vehicle.edgeIndex = 0;
    vehicle.edgeProgress = 0;
    delete vehicle.mergeWaitSinceTick;
    const occupancyKey = tileNumberKey(accessRoad.x, accessRoad.y);
    occ.set(occupancyKey, (occ.get(occupancyKey) ?? 0) + 1);
    mergedAccessRoads.add(accessKey);
  }
}

/** 通常走行と合流判定で共有する、有向辺・論理レーン・希望速度の表現を作る。 */
function plannedMovement(
  vehicle: Vehicle,
  road: TrafficRoadReader | null,
  occ: OccupancyMap,
): PlannedMovement | null {
  const cur = vehicle.path[vehicle.edgeIndex];
  const next = vehicle.path[vehicle.edgeIndex + 1];
  if (!cur || !next) return null;
  const edgeKey = directedEdgeKey(cur, next);
  const lane = road ? logicalLaneIndex(vehicle.id, edgeRoadRank(road, cur, next)) : 0;
  // 合流候補はまだ occ に入っていないので、自車ぶんだけ加えて希望速度を求める。
  const occupancy = Math.max(
    1,
    (occ.get(tileNumberKey(cur.x, cur.y)) ?? 0) + (vehicle.phase === 'road' ? 0 : 1),
  );
  const capacity =
    TRAFFIC.CAPACITY * (road?.rank(cur.x, cur.y) === 2 ? TRAFFIC.ARTERIAL_CAPACITY_MULTIPLIER : 1);
  const speed = TRAFFIC.VMAX * Math.max(0.2, 1 - occupancy / capacity);
  const desiredDelta = (speed * DT_SECONDS) / edgeLength(cur, next);
  return {
    vehicle,
    cur,
    next,
    edgeKey,
    lane,
    progress: vehicle.edgeProgress,
    indexInEdge: 0,
    desiredDelta,
    delta: desiredDelta,
  };
}

function insertIndexedMovement(
  road: TrafficRoadReader | null,
  movement: PlannedMovement,
  byEdge: Map<number, PlannedMovement[]>,
): void {
  const key = road ? edgeLaneKey(movement.edgeKey, movement.lane) : movement.edgeKey;
  const list = byEdge.get(key);
  if (!list) {
    movement.indexInEdge = 0;
    byEdge.set(key, [movement]);
    return;
  }
  let index = 0;
  while (
    index < list.length &&
    (list[index]!.progress > movement.progress ||
      (list[index]!.progress === movement.progress &&
        list[index]!.vehicle.id < movement.vehicle.id))
  ) {
    index++;
  }
  list.splice(index, 0, movement);
  for (let i = index; i < list.length; i++) list[i]!.indexInEdge = i;
}

function removeIndexedMovement(
  road: TrafficRoadReader | null,
  movement: PlannedMovement,
  byEdge: Map<number, PlannedMovement[]>,
): void {
  const key = road ? edgeLaneKey(movement.edgeKey, movement.lane) : movement.edgeKey;
  const list = byEdge.get(key);
  if (!list) return;
  const index = list.indexOf(movement);
  if (index < 0) return;
  list.splice(index, 1);
  if (list.length === 0) {
    byEdge.delete(key);
    return;
  }
  for (let i = index; i < list.length; i++) list[i]!.indexInEdge = i;
}

/**
 * 交差点の停止位置を、タイル中心からの距離（タイル単位）で返す。
 *
 * **描画の停止線はこの値から導出すること。** sim と描画で別々に数値を持つと、
 * 実際に止まる位置と赤い線がずれる（実際に半タイル以上ずれていた）。
 */
export function intersectionStopDistanceFromCenter(): number {
  return 1 - TRAFFIC.INTERSECTION_STOP_PROGRESS;
}

interface IntersectionCandidate {
  movement: PlannedMovement;
  axis: IntersectionAxis;
  /** 同一辺の追従を適用した後、交差点制御を適用する前の移動量 */
  entryDelta: number;
}

/**
 * 交差点中心を、保存可能な需要応答信号で排他的に使う。
 *
 * プレイヤー指定の優先軸は「初期の青」かつ「通常より長い最低青」とする。
 * ただし即時反転はせず、従側が最大待機時間へ達すれば全赤を挟んで譲る。
 * 指定なしでは、最低青の後に対向軸の方が長く待っている場合だけ切り替える。
 * どちらの場合も需要がない軸へは切り替えない。
 */
function applyIntersectionConflicts(state: GameState, movements: PlannedMovement[]): void {
  const intersectionCache = new Map<number, OrthogonalIntersection | null>();
  const candidatesByIntersection = new Map<number, IntersectionCandidate[]>();

  for (const movement of movements) {
    // このtickに**停止線**を越えない車は、まだ交差点の許可を奪い合わない。
    // 以前は「辺の終端(1.0)を越えるか」で見ていたが、停止線を交差点の手前
    // （INTERSECTION_STOP_PROGRESS）へ下げたので、判定もそこに合わせないと
    // 「停止線を通り過ぎてから止まる」ことになる。
    if (movement.progress + movement.delta < TRAFFIC.INTERSECTION_STOP_PROGRESS) {
      if (movement.vehicle.intersectionWaitSinceTick !== undefined) {
        delete movement.vehicle.intersectionWaitSinceTick;
      }
      continue;
    }

    const key = tileNumberKey(movement.next.x, movement.next.y);
    let intersection = intersectionCache.get(key);
    if (intersection === undefined) {
      intersection = orthogonalIntersectionAt(state.grid, movement.next.x, movement.next.y);
      intersectionCache.set(key, intersection);
    }
    if (!intersection) {
      if (movement.vehicle.intersectionWaitSinceTick !== undefined) {
        delete movement.vehicle.intersectionWaitSinceTick;
      }
      continue;
    }

    movement.vehicle.intersectionWaitSinceTick ??= state.tick;
    const candidate: IntersectionCandidate = {
      movement,
      axis: approachAxis(movement.cur, movement.next),
      entryDelta: movement.delta,
    };
    const candidates = candidatesByIntersection.get(key);
    if (candidates) candidates.push(candidate);
    else candidatesByIntersection.set(key, [candidate]);

    // いったん全候補を停止線で止め、下で選んだ軸だけ元の移動量へ戻す。
    const toStopLine = Math.max(0, TRAFFIC.INTERSECTION_STOP_PROGRESS - movement.progress);
    movement.delta = Math.min(movement.delta, toStopLine);
  }

  const occupiedAxes = new Map<number, IntersectionAxis | 'conflict'>();
  for (const movement of movements) {
    const key = tileNumberKey(movement.cur.x, movement.cur.y);
    if (!candidatesByIntersection.has(key)) continue;
    const previous = movement.vehicle.path[movement.vehicle.edgeIndex - 1];
    const axis = previous
      ? approachAxis(previous, movement.cur)
      : approachAxis(movement.next, movement.cur);
    const occupied = occupiedAxes.get(key);
    occupiedAxes.set(key, occupied && occupied !== axis ? 'conflict' : axis);
  }

  for (const [numberKey, candidates] of candidatesByIntersection) {
    const intersection = intersectionCache.get(numberKey) as OrthogonalIntersection;
    const stateKey = tileKeyOf(intersection.pos.x, intersection.pos.y);
    let signal = ensureIntersectionSignal(state, intersection.pos);
    const priority = state.intersectionPriorities?.[stateKey];
    const occupiedAxis = occupiedAxes.get(numberKey);

    if (signal.phase === 'allRed') {
      const clearingAxis = signal.clearingAxis;
      const nextGreenAxis = signal.nextGreenAxis;
      const clearing = candidates.filter(
        (candidate) =>
          candidate.axis === clearingAxis &&
          candidate.movement.progress > TRAFFIC.INTERSECTION_STOP_PROGRESS,
      );
      grantIntersectionCandidates(state, stateKey, clearing);

      const elapsed = state.tick - signal.phaseStartedTick;
      const centerStillOccupied = occupiedAxis === 'conflict' || occupiedAxis === clearingAxis;
      if (elapsed < TRAFFIC.SIGNAL_ALL_RED_TICKS || clearing.length > 0 || centerStillOccupied) {
        continue;
      }
      signal = {
        phase: 'green',
        greenAxis: nextGreenAxis,
        phaseStartedTick: state.tick,
      };
      state.intersectionSignals![stateKey] = signal;
    }

    const signalView = intersectionSignalAt(state, intersection.pos);
    const greenAxis = signal.greenAxis;
    const greenCandidates = candidates.filter((candidate) => candidate.axis === greenAxis);
    const opposingCandidates = candidates.filter((candidate) => candidate.axis !== greenAxis);
    const minimumHeld =
      state.tick - signal.phaseStartedTick >= minimumGreenTicks(state, stateKey, greenAxis);
    let shouldSwitch = false;
    if (minimumHeld && opposingCandidates.length > 0) {
      if (greenCandidates.length === 0) {
        shouldSwitch = true;
      } else if (priority === greenAxis) {
        shouldSwitch =
          waitedTicks(state, bestCandidate(opposingCandidates)) >=
          TRAFFIC.INTERSECTION_MAX_YIELD_TICKS;
      } else {
        // 通常現示、または従側現示から優先軸へ戻る場合。青側は前tickに通して
        // waitSince を消しているため、継続待ちの赤側が固定全順序で必ず勝つ。
        shouldSwitch =
          waitedTicks(state, bestCandidate(opposingCandidates)) >=
          waitedTicks(state, bestCandidate(greenCandidates));
      }
    }

    if (shouldSwitch) {
      const nextGreenAxis = bestCandidate(opposingCandidates).axis;
      state.intersectionSignals![stateKey] = {
        phase: 'allRed',
        greenAxis: null,
        clearingAxis: greenAxis,
        nextGreenAxis,
        phaseStartedTick: state.tick,
      };
      // 青の最終tickまでに停止線を越えた車は新規進入ではない。全赤中も中心へ
      // 進ませて排出し、それ以外（停止線上を含む）は両軸とも赤で止める。
      grantIntersectionCandidates(
        state,
        stateKey,
        greenCandidates.filter(
          (candidate) => candidate.movement.progress > TRAFFIC.INTERSECTION_STOP_PROGRESS,
        ),
      );
      continue;
    }

    // 古いセーブ等で反対軸がまだ中心に残っていれば、安全のため青でも進入させない。
    // 信号状態が通常遷移している限りは全赤で排出済みなので、この分岐には入らない。
    if (occupiedAxis && occupiedAxis !== greenAxis) continue;
    grantIntersectionCandidates(
      state,
      stateKey,
      candidates.filter((candidate) => intersectionAxisCanEnter(signalView, candidate.axis)),
    );
  }

  // 候補車がいない交差点でも全赤を時間どおり終える。これを候補ループだけで
  // 行うと、交通が途切れた交差点が画面上で永久に全赤のまま残ってしまう。
  for (const [stateKey, signal] of Object.entries(state.intersectionSignals ?? {})) {
    if (signal.phase !== 'allRed') continue;
    const [xText, yText] = stateKey.split(',');
    const numberKey = tileNumberKey(Number(xText), Number(yText));
    if (candidatesByIntersection.has(numberKey)) continue;
    if (state.tick - signal.phaseStartedTick < TRAFFIC.SIGNAL_ALL_RED_TICKS) continue;
    state.intersectionSignals![stateKey] = {
      phase: 'green',
      greenAxis: signal.nextGreenAxis,
      phaseStartedTick: state.tick,
    };
  }
}

function grantIntersectionCandidates(
  state: GameState,
  stateKey: string,
  candidates: IntersectionCandidate[],
): void {
  candidates.sort(compareIntersectionCandidates);
  for (const candidate of candidates) {
    candidate.movement.delta = candidate.entryDelta;
    delete candidate.movement.vehicle.intersectionWaitSinceTick;
  }
  if (candidates.length === 0) return;
  state.intersectionLastServedAxes ??= {};
  state.intersectionLastServedAxes[stateKey] = candidates[0]!.axis;
}

function bestCandidate(candidates: IntersectionCandidate[]): IntersectionCandidate {
  return candidates.slice().sort(compareIntersectionCandidates)[0] as IntersectionCandidate;
}

function waitedTicks(state: GameState, candidate: IntersectionCandidate): number {
  return state.tick - (candidate.movement.vehicle.intersectionWaitSinceTick ?? state.tick);
}

/** 待ち始めたtick → 有向辺 → 進捗 → id の固定全順序。 */
function compareIntersectionCandidates(a: IntersectionCandidate, b: IntersectionCandidate): number {
  const aSince = a.movement.vehicle.intersectionWaitSinceTick ?? 0;
  const bSince = b.movement.vehicle.intersectionWaitSinceTick ?? 0;
  if (aSince !== bSince) return aSince - bSince;
  if (a.movement.edgeKey !== b.movement.edgeKey) return a.movement.edgeKey - b.movement.edgeKey;
  if (a.movement.progress !== b.movement.progress) return b.movement.progress - a.movement.progress;
  return a.movement.vehicle.id - b.movement.vehicle.id;
}

/** 往路到着では成果を1回だけ記録して滞在へ入り、復路到着では車を消す */
function arrive(state: GameState, v: Vehicle): boolean {
  if (v.leg === 'return') return false;
  if (v.purpose.fromBuildingId >= 0) applyTripSuccess(state, v.purpose.fromBuildingId);
  deliverCargo(state, v);
  v.phase = 'dwell';
  v.accessProgress = 0;
  v.dwellUntilTick = state.tick + TRAFFIC.DESTINATION_DWELL_TICKS;
  return true;
}

/**
 * 時間切れ。出発元の満足度が下がる（実装書 §8.3）。
 * spawn 時に totalTrips を数えているので、ここでは failedTrips だけ増やす。
 */
function timeout(state: GameState, v: Vehicle): void {
  state.progress.failedTrips++;
  state.progress.failedToday++;
  const b = state.buildings.find((x) => x.id === v.purpose.fromBuildingId);
  if (!b) return;
  const floor = b.zone === 'residential' ? satisfactionFloorAt(state, b.pos) : 0;
  b.satisfaction = Math.max(floor, b.satisfaction + GROWTH.SATISFACTION_TRIP_FAIL);
  // 経路なしの失敗（applyTripFailure）と同じカウンタに入れる。インスペクタは
  // 「時間切れ」と「道がない」を区別せず「着けなかった車」としてまとめて見せる
  b.tripsFailToday++;
}

/** 描画用: 車の現在位置と向き（線形補間） */
export interface VehicleView {
  id: number;
  x: number;
  y: number;
  angle: number;
  kind: Vehicle['kind'];
  leg: Vehicle['leg'];
  /**
   * sim が持つ明示的な移動フェーズ。実際の `vehicleViews()` は常に設定する。
   * optional なのは描画補間の外部テストフィクスチャとの後方互換だけのため。
   */
  phase?: Exclude<VehiclePhase, 'dwell'>;
  /** exiting / entering はアクセス進捗、road は現在の道路辺の進捗 */
  phaseProgress?: number;
  /** アクセス道路上の車線方向。私道と道路の境界で車線位置を連続させる */
  accessRoadAngle?: number;
  /** 現在見えている道路辺のランク。外部描画フィクスチャ互換のため省略時は1。 */
  roadRank?: 1 | 2;
  /** 現在の辺を 0..1 で進んだ割合 */
  edgeProgress: number;
  /** @deprecated `phase === 'exiting'` と同値。既存の描画補間呼び出しとの互換用 */
  exitEdge: boolean;
  /** @deprecated `phase === 'entering'` と同値。既存の描画補間呼び出しとの互換用 */
  entranceEdge: boolean;
  /** この脚で「出てきた」建物の座標。往路なら出発元、復路なら目的地 */
  exitPos: TilePos;
  /** この脚で「入る」建物の座標。往路なら目的地、復路なら出発元 */
  entrancePos: TilePos;
}

export function vehicleViews(state: GameState): VehicleView[] {
  const out: VehicleView[] = [];
  const roadReader = new TrafficRoadReader(state.grid);
  for (const v of state.vehicles) {
    if (v.phase === 'dwell') continue;
    const exitPos = legOrigin(v);
    const entrancePos = legDestination(v);
    let x: number;
    let y: number;
    let angle: number;
    let phaseProgress: number;
    let viewRoadRank: 1 | 2;

    if (v.phase === 'exiting') {
      const road = v.path[0];
      if (!road) continue;
      const p = v.accessProgress;
      x = exitPos.x + 0.5 + (road.x - exitPos.x) * p;
      y = exitPos.y + 0.5 + (road.y - exitPos.y) * p;
      angle = Math.atan2(road.y - exitPos.y, road.x - exitPos.x);
      phaseProgress = p;
      const next = v.path[1];
      viewRoadRank = next
        ? edgeRoadRank(roadReader, road, next)
        : roadReader.rank(road.x, road.y) === 2
          ? 2
          : 1;
    } else if (v.phase === 'entering') {
      const road = v.path[v.path.length - 1];
      if (!road) continue;
      const p = v.accessProgress;
      x = road.x + 0.5 + (entrancePos.x - road.x) * p;
      y = road.y + 0.5 + (entrancePos.y - road.y) * p;
      angle = Math.atan2(entrancePos.y - road.y, entrancePos.x - road.x);
      phaseProgress = p;
      const previous = v.path[v.path.length - 2];
      viewRoadRank = previous
        ? edgeRoadRank(roadReader, previous, road)
        : roadReader.rank(road.x, road.y) === 2
          ? 2
          : 1;
    } else {
      const a = v.path[v.edgeIndex];
      const b = v.path[v.edgeIndex + 1];
      if (!a || !b) continue;
      const p = v.edgeProgress;
      x = a.x + 0.5 + (b.x - a.x) * p;
      y = a.y + 0.5 + (b.y - a.y) * p;
      angle = Math.atan2(b.y - a.y, b.x - a.x);
      phaseProgress = p;
      viewRoadRank = edgeRoadRank(roadReader, a, b);
    }

    out.push({
      id: v.id,
      kind: v.kind,
      leg: v.leg,
      phase: v.phase,
      phaseProgress,
      accessRoadAngle:
        v.phase === 'exiting'
          ? angleBetween(v.path[0], v.path[1])
          : v.phase === 'entering'
            ? angleBetween(v.path[v.path.length - 2], v.path[v.path.length - 1])
            : undefined,
      roadRank: viewRoadRank,
      edgeProgress: v.edgeProgress,
      exitEdge: v.phase === 'exiting',
      entranceEdge: v.phase === 'entering',
      exitPos,
      entrancePos,
      x,
      y,
      angle,
    });
  }
  return out;
}

function angleBetween(a: TilePos | undefined, b: TilePos | undefined): number | undefined {
  return a && b ? Math.atan2(b.y - a.y, b.x - a.x) : undefined;
}

/**
 * 実装書 §6: 明らかに遅れている車（再探索の対象になる）。
 *
 * 条件は2つとも満たすこと:
 *  1. 脚の出発から `TICKS_STUCK` を超えている（出発直後の車を触らない）
 *  2. **残り経路の平均混雑度が `REROUTE_CONGESTION_THRESHOLD` 以上**
 *
 * **2 を必須にしている理由（実測に基づく）**: 当初は「辺の先頭付近にいる」だけでも
 * 候補にしていたが、それだと*混雑と無関係に*「たまたま辺に入ったばかりの車」が
 * 大量に候補になる。再探索の予算は1判定tickあたり1台しかないので、
 * **渋滞していない車が予算を食い潰し、本当に詰まっている車に順番が回らない**。
 * 実測（12,000tick・人口208）では候補が988回発生したが、その改善率は全件0%だった。
 *
 * `edgeProgress` の条件は「候補の中で優先する」ためだけに使う（`rerouteScore`）。
 */
export function isStuck(state: GameState, v: Vehicle, congestion?: CongestionMap): boolean {
  if (v.phase !== 'road' || state.tick - v.legStartedTick <= ROAD.TICKS_STUCK) return false;
  if (!congestion) return false;
  return remainingCongestion(v, congestion) >= ROAD.REROUTE_CONGESTION_THRESHOLD;
}

/**
 * 残り経路の平均混雑度。0..1。
 *
 * **先頭 `REROUTE_SCAN_TILES` タイルまでしか見ない。** 判定tickに全車ぶん走るので、
 * 経路が長いほど重くなる形にはできない。すぐ先が詰まっているかが判断材料として
 * 妥当でもある（何十タイルも先の混雑は、着く頃には変わっている）。
 */
function remainingCongestion(v: Vehicle, congestion: CongestionMap): number {
  const end = Math.min(v.path.length, v.edgeIndex + 1 + ROAD.REROUTE_SCAN_TILES);
  let total = 0;
  let count = 0;
  for (let i = v.edgeIndex + 1; i < end; i++) {
    const tile = v.path[i] as TilePos;
    total += congestionAt(congestion, tile.x, tile.y);
    count++;
  }
  return count > 0 ? total / count : 0;
}
