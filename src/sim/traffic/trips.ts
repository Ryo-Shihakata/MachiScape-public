/**
 * 建物ベースのトリップ生成（実装書 §7.1・§7.2）。
 *
 * M1 までは道路タイル間のダミートリップだったが、M2 で街ができたので
 * 「住宅から商業・工業・施設へ人が動く」「工業から商業へ物が動く」という
 * 実際の需要に置き換える。渋滞はこの流れの結果として生まれる。
 */

import { GROWTH, LOGISTICS, ROAD, TIME, TRAFFIC } from '../balance';
import { extraTripTargetsAt, satisfactionFloorAt } from '../facility';
import type { FacilityDef } from '../facility/defs';
import { hasRoad } from '../grid';
import { chance, weightedPick, type Rng } from '../rng';
import { findPath } from '../road/pathfind';
import type { CongestionMap } from '../road/congestion';
import { tileKey, type Building, type GameState, type TilePos, type Vehicle } from '../types';

/**
 * 建物に隣接する道路タイル（出発点・到着点になる）。
 * 建物そのものは道路ではないので、車は最寄りの道路から出入りする。
 */
export function accessRoadNear(
  state: GameState,
  pos: TilePos,
  footprint: FacilityDef['footprint'] = 1,
): TilePos | null {
  const d = ROAD.ROAD_ACCESS_DISTANCE;
  const size = footprint === 4 ? 2 : 1;
  const right = pos.x + size - 1;
  const bottom = pos.y + size - 1;
  let best: TilePos | null = null;
  let bestDist = Infinity;
  // y → x の固定順。同距離はこの順で最初に見つけた道路を採る。
  for (let y = pos.y - d; y <= bottom + d; y++) {
    for (let x = pos.x - d; x <= right + d; x++) {
      if (!hasRoad(state.grid, x, y)) continue;
      const dx = x < pos.x ? pos.x - x : x > right ? x - right : 0;
      const dy = y < pos.y ? pos.y - y : y > bottom ? y - bottom : 0;
      const dist = dx + dy;
      if (dist > d) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = { x, y };
      }
    }
  }
  return best;
}

/** 既存呼び出し用の1x1建物ラッパ。 */
export function accessRoadOf(state: GameState, b: Building): TilePos | null {
  return accessRoadNear(state, b.pos, 1);
}

/** 目的地の候補と重み（実装書 §7.1: 種別の重み × 距離減衰） */
function pickDestination(state: GameState, from: Building, rng: Rng): Building | null {
  const candidates: Building[] = [];
  const weights: number[] = [];

  for (const b of state.buildings) {
    if (!b.occupied || b.id === from.id) continue;
    let typeWeight = 0;
    if (b.zone === 'commercial') typeWeight = TRAFFIC.DEST_WEIGHT_COMMERCIAL;
    else if (b.zone === 'industrial') typeWeight = TRAFFIC.DEST_WEIGHT_INDUSTRIAL;
    if (typeWeight === 0) continue;

    const dist = Math.abs(b.pos.x - from.pos.x) + Math.abs(b.pos.y - from.pos.y);
    candidates.push(b);
    weights.push(typeWeight / (1 + dist / TRAFFIC.DISTANCE_FALLOFF));
  }

  const idx = weightedPick(rng, weights);
  return idx < 0 ? null : (candidates[idx] ?? null);
}

/**
 * 出発元の建物 id → いま道路に出ている車の数。
 *
 * 復路の車も「まだ帰ってきていない」ので数に入れる。往路だけを数えると、
 * 目的地に着いた瞬間に次の車が出てしまい、上限の意味が半分になる。
 */
export function activeTripCounts(state: GameState): Map<number, number> {
  const counts = new Map<number, number>();
  for (const v of state.vehicles) {
    const id = v.purpose.fromBuildingId;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** 出発元の建物 id と施設の種類の組。施設トリップの枠を種類ごとに分けるためのキー */
function extraTripKey(buildingId: number, defId: string): string {
  return `${buildingId}\u0000${defId}`;
}

/**
 * 施設へ向かう移動（通学など）の、出発元 × 施設種類ごとの本数。
 *
 * 通常の外出とは**別枠**で数える。共有すると、住宅はほぼ常に1台出ているので
 * 通学の車がほぼ必ず上限に弾かれ、未処理需要が増えるだけで路上の車が増えない
 * （実測で通過台数+3%。`docs/m6-plan.md` §5 死因2）。
 *
 * 行き先が施設かどうかは `grid.facilityIndex` を引いて判定する。
 * `Vehicle` に印を足さないのは、車が1,500台ぶんメモリに乗るため
 * （`sim/types.ts` に同じ趣旨の注意がある）。
 */
function activeExtraTripCounts(state: GameState): Map<string, number> {
  const counts = new Map<string, number>();
  if (state.facilities.length === 0) return counts;
  const byId = new Map(state.facilities.map((f) => [f.id, f]));
  for (const v of state.vehicles) {
    const id = state.grid.facilityIndex[tileKey(v.purpose.to.x, v.purpose.to.y)];
    if (id === undefined) continue;
    const f = byId.get(id);
    if (!f) continue;
    const key = extraTripKey(v.purpose.fromBuildingId, f.defId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * 人の移動（実装書 §7.1）。
 * 入居済み住宅から確率的に出発する。経路が無ければ車を出さず、
 * その建物の満足度を下げる（＝道路網の不備がプレイヤーに伝わる）。
 */
export function spawnPeopleTrips(
  state: GameState,
  congestion: CongestionMap,
  rng: Rng,
  budget: { remaining: number },
): void {
  // 全体上限なら住宅別の出発中台数を数えても必ず出せない。1500台を毎tick走査する前に返す。
  // 抽選前の上限判定なので乱数消費順も変えない。
  if (budget.remaining <= 0 || state.vehicles.length >= TRAFFIC.MAX_VEHICLES) return;

  // 出発中の車を出発元ごとに数える（`MAX_ACTIVE_TRIPS_PER_BUILDING` の背圧）。
  // 車1台につき1回の加算で済むので、住宅を1棟ずつ全車と突き合わせるより速い。
  const active = activeTripCounts(state);
  // 施設トリップは種類ごとに別枠で数える（下の通学の節を参照）
  const activeExtra = activeExtraTripCounts(state);

  const homes = state.buildings.filter((b) => b.occupied && b.zone === 'residential');
  for (const home of homes) {
    if (budget.remaining <= 0) return;
    if (state.vehicles.length >= TRAFFIC.MAX_VEHICLES) return;
    // **上限より先に抽選を引く。** 順序がこの機能の要点そのもの（`docs/m6-plan.md` §1-2）。
    //
    // 上限で先に弾くと「出発したかった回数」ではなく「塞がっていた tick 数」を
    // 数えることになり、実測で完了190件に対し未処理51,226件という無意味な値になった
    // （TRIP_RATE_R が 0.01 なので約100倍に膨らむ）。
    // 先に抽選を引けば、未処理は**本当に出発するはずだった移動の数**と一致する。
    //
    // 乱数の消費量も、こちらの方がむしろ安定する（住宅1棟につき毎tick必ず1回）。
    // 上限で先に弾く形だと消費量が渋滞具合で変わっていた。
    if (chance(rng, TRAFFIC.TRIP_RATE_R)) {
      // 出したいのに出せない＝道路網が足りていない証拠。**車は増やさない。数えるだけ。**
      if ((active.get(home.id) ?? 0) >= TRAFFIC.MAX_ACTIVE_TRIPS_PER_BUILDING) {
        state.progress.unservedToday++;
      } else {
        const dest = pickDestination(state, home, rng);
        if (dest && spawnPeopleTrip(state, congestion, home, dest.pos, 1, budget)) {
          active.set(home.id, (active.get(home.id) ?? 0) + 1);
        }
      }
    }

    // 通学は通常外出とは別の抽選で、**上限の枠も別に持つ**。
    //
    // 枠を共有すると、この施設の存在意義そのものが消える。住宅はほぼ常に
    // 「1台出ている」状態なので、通学の抽選に当たってもほぼ必ず上限に弾かれ、
    // 未処理需要が増えるだけで**路上の車は増えない**。実測でも通過台数は+3%しか
    // 変わらず、「置いた瞬間に流量が変わるのが見える」という受け入れ基準
    // （`docs/m6-plan.md` §5 死因2）を満たせなかった。
    //
    // 枠を分けるのは筋も通っている。学校の効果は「その家に通学する子が増える」で
    // あって、親の外出が減るわけではない。**恩恵の範囲がそのまま渋滞の原因になる**
    // という設計意図は、枠を分けて初めて成立する。
    if (state.facilities.length === 0) continue;
    for (const target of extraTripTargetsAt(state, home.pos)) {
      if (budget.remaining <= 0 || state.vehicles.length >= TRAFFIC.MAX_VEHICLES) return;
      if (!chance(rng, target.rate)) continue;
      const key = extraTripKey(home.id, target.defId);
      if ((activeExtra.get(key) ?? 0) >= TRAFFIC.MAX_ACTIVE_TRIPS_PER_BUILDING) {
        state.progress.unservedToday++;
        continue;
      }
      if (spawnPeopleTrip(state, congestion, home, target.pos, target.footprint, budget)) {
        activeExtra.set(key, (activeExtra.get(key) ?? 0) + 1);
      }
    }
  }
}

/** 経路探索から車両登録までを、通常外出と追加施設トリップで共有する。 */
function spawnPeopleTrip(
  state: GameState,
  congestion: CongestionMap,
  home: Building,
  destination: TilePos,
  destinationFootprint: FacilityDef['footprint'],
  budget: { remaining: number },
): boolean {
  const from = accessRoadOf(state, home);
  const to = accessRoadNear(state, destination, destinationFootprint);
  if (!from || !to) {
    applyTripFailure(state, home);
    return false;
  }

  budget.remaining--;
  const path = findPath(state.grid, congestion, from, to);
  if (!path || path.length < 2) {
    applyTripFailure(state, home);
    return false;
  }

  state.vehicles.push({
    id: state.nextId++,
    kind: 'car',
    mode: 'road',
    leg: 'outbound',
    legStartedTick: state.tick,
    dwellUntilTick: null,
    phase: 'exiting',
    accessProgress: 0,
    path,
    edgeIndex: 0,
    edgeProgress: 0,
    purpose: {
      fromBuildingId: home.id,
      from: { x: home.pos.x, y: home.pos.y },
      to: { x: destination.x, y: destination.y },
      startedTick: state.tick,
    },
  });
  state.progress.totalTrips++;
  state.progress.tripsToday++;
  return true;
}

/**
 * 物流（実装書 §7.2）。
 * 在庫が減った商業が、最寄りの在庫十分な工業へ配送を要求する。
 *
 * 関数は毎tick呼ぶが、各商業を処理するのは `building.id % TICKS_PER_DAY` と
 * 現在の時刻が一致する1日1回だけ。新しいstateを持たずに出発時刻を分散しつつ、
 * 供給不足を1日600回記録して満足度を即死させない性質を保つ。
 *
 * 出庫はトラック生成時に減算し、次の要求は減算後の値で判定する
 * （同日に複数の要求が来たとき、同じ在庫から二重に払い出さないため）。
 */
export function spawnFreightTrips(
  state: GameState,
  congestion: CongestionMap,
  budget: { remaining: number },
): void {
  const tickOfDay = state.tick % TIME.TICKS_PER_DAY;
  // building id 昇順で逐次処理する（順序が揺れると決定論が壊れる）。
  // id由来のオフセットなのでセーブ対象の新しいスケジュールstateは不要。
  // ほとんどのtickは該当0棟なので、毎tick filter が空配列を作らないよう遅延生成する。
  let shops: Building[] | undefined;
  for (const b of state.buildings) {
    if (
      b.zone !== 'commercial' ||
      !b.occupied ||
      (b.stock ?? 0) >= LOGISTICS.RESTOCK_THRESHOLD ||
      b.id % TIME.TICKS_PER_DAY !== tickOfDay
    ) {
      continue;
    }
    (shops ??= []).push(b);
  }
  if (!shops) return;
  shops.sort((a, b) => a.id - b.id);

  for (const shop of shops) {
    if (budget.remaining <= 0) return;
    if (state.vehicles.length >= TRAFFIC.MAX_VEHICLES) return;

    // 供給元がそもそも無いのは「道路網の失敗」ではないので、トリップ失敗に数えない。
    // 工業が足りないことの罰は在庫切れ（§8.3 の SATISFACTION_OUT_OF_STOCK）が担う。
    // ここで二重に罰すると、工業を建てる前の序盤で商業が必ず全滅する。
    const factory = nearestSupplier(state, shop);
    if (!factory) continue;

    const from = accessRoadOf(state, factory);
    const to = accessRoadOf(state, shop);
    if (!from || !to) {
      applyTripFailure(state, shop);
      continue;
    }

    budget.remaining--;
    const path = findPath(state.grid, congestion, from, to);
    if (!path || path.length < 2) {
      applyTripFailure(state, shop);
      continue;
    }

    // 出庫はここで確定させる
    factory.output = Math.max(0, (factory.output ?? 0) - LOGISTICS.TRUCK_LOAD);

    state.vehicles.push({
      id: state.nextId++,
      kind: 'truck',
      mode: 'road',
      leg: 'outbound',
      legStartedTick: state.tick,
      dwellUntilTick: null,
      phase: 'exiting',
      accessProgress: 0,
      path,
      edgeIndex: 0,
      edgeProgress: 0,
      purpose: {
        fromBuildingId: factory.id,
        from: { x: factory.pos.x, y: factory.pos.y },
        to: { x: shop.pos.x, y: shop.pos.y },
        startedTick: state.tick,
      },
    });
    state.progress.totalTrips++;
    state.progress.tripsToday++;
  }
}

function nearestSupplier(state: GameState, shop: Building): Building | null {
  let best: Building | null = null;
  let bestDist = Infinity;
  for (const b of state.buildings) {
    if (!b.occupied || b.zone !== 'industrial') continue;
    if ((b.output ?? 0) < LOGISTICS.SUPPLY_MIN_OUTPUT) continue;
    const dist = Math.abs(b.pos.x - shop.pos.x) + Math.abs(b.pos.y - shop.pos.y);
    // 同距離なら id の小さい方（決定論のため）
    if (dist < bestDist || (dist === bestDist && best !== null && b.id < best.id)) {
      bestDist = dist;
      best = b;
    }
  }
  return best;
}

// 満足度の増減は日次処理とは別に、車の到着・失敗で即時に効く（実装書 §8.3）

/**
 * 到着できなかったトリップの記録（実装書 §8.3 の満足度低下につながる）。
 * 失敗も「試みられたトリップ」なので totalTrips に数える。数えないと
 * failedTrips / totalTrips が実際の失敗率より大きく出て、需要が不当に沈む。
 */
export function applyTripFailure(state: GameState, b: Building): void {
  const floor = b.zone === 'residential' ? satisfactionFloorAt(state, b.pos) : 0;
  b.satisfaction = Math.max(floor, b.satisfaction + GROWTH.SATISFACTION_TRIP_FAIL);
  // インスペクタが「満足度がいま下がっている理由」を言えるようにする日次カウンタ
  // （`updateSatisfaction` の末尾でリセットされる）
  b.tripsFailToday++;
  state.progress.failedTrips++;
  state.progress.totalTrips++;
  state.progress.failedToday++;
  state.progress.tripsToday++;
}

/** 到着したトリップの記録 */
export function applyTripSuccess(state: GameState, buildingId: number): void {
  const b = state.buildings.find((x) => x.id === buildingId);
  if (!b) return;
  b.satisfaction = Math.min(100, b.satisfaction + GROWTH.SATISFACTION_TRIP_SUCCESS);
  b.tripsOkToday++;
}

/** 到着した車の積荷を届ける（トラックのみ） */
export function deliverCargo(state: GameState, v: Vehicle): void {
  if (v.kind !== 'truck') return;
  const shop = state.buildings.find(
    (b) => b.pos.x === v.purpose.to.x && b.pos.y === v.purpose.to.y,
  );
  if (!shop || shop.zone !== 'commercial') return;
  shop.stock = Math.min(LOGISTICS.STOCK_MAX, (shop.stock ?? 0) + LOGISTICS.TRUCK_LOAD);
}
