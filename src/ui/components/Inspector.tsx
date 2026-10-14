/**
 * インスペクタ（タップした要素の詳細・実装書 §12.3、`docs/m3-plan.md` §4 の 3-2）。
 *
 * **このパネルの仕事は「数字を出すこと」ではなく「数字の行き先を見せること」。**
 * オーナーの指摘は「パラメーターが分かりづらい。具体的になんの数字か、どこに連動して
 * いるか見たい」だった。だから満足度・在庫・到着数のどの行にも、必ず
 * 「その数字が何に繋がるか」の一文を添える（文言は `i18n/ja.ts` の `inspector.*`）。
 *
 * データの読み方:
 * - 対象タイルは `useUiStore` の `selection`（`src/game/loop.ts` が
 *   「移動ツール中のタップ」で入れる）。閉じるのは `setSelection(null)`
 * - 詳細は `getCurrentWorld()` から読む。HUD の store に GameState を載せない設計
 *   （10Hz で React が再描画されてしまう）なので、**選択中だけ 250ms 間隔で読み直す**
 * - **state を書き換えないこと**（`src/game/current.ts` の規約）
 *
 * 数値は必ず `balance.ts` から引き、文章は `tp()` のプレースホルダに流し込む。
 * ここに直書きすると、バランス調整のときに説明文だけが古くなって実挙動と食い違う
 * （それが一番たちの悪い「分かりにくさ」になる）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEMAND, ECONOMY, GROWTH, LOGISTICS, ROAD, TIME } from '../../sim/balance';
import { buildingIdAt, hasRoad, hasRoadAccess, terrainAt, zoneAt } from '../../sim/grid';
import { congestionAt } from '../../sim/road/congestion';
import { orthogonalIntersectionAt } from '../../sim/road/intersection';
import { traceVehicle, tracesForBuilding, type TripTrace } from '../../sim/traffic/trace';
import {
  tileKey,
  type IntersectionAxis,
  type TileKind,
  type TilePos,
  type ZoneType,
} from '../../sim/types';
import { getCurrentWorld } from '../../game/current';
import { t, tp } from '../../i18n/ja';
import { useUiStore } from '../store';
import '../inspector.css';

/** 詳細を読み直す間隔。`src/game/current.ts` の規約（毎フレーム読まない） */
const REFRESH_MS = 250;

// ---------------------------------------------------------------------------
// 読み取り: World から「1タイルぶんの事実」を切り出す
// ---------------------------------------------------------------------------

interface BuildingSnapshot {
  zone: ZoneType;
  occupied: boolean;
  satisfaction: number;
  lowSatisfactionDays: number;
  tripsOkToday: number;
  tripsFailToday: number;
  stock?: number;
  output?: number;
  departingVehicles: number;
  arrivingVehicles: number;
  /** 相手先ごとの内訳（`docs/m5-plan.md` §3-4）。count 降順 */
  departingBreakdown: CounterpartBreakdown[];
  arrivingBreakdown: CounterpartBreakdown[];
}

/** 相手先1件ぶん（§3-4）。「商業(18,3)へ 3台」のような行の元データ */
export interface CounterpartBreakdown {
  pos: TilePos;
  zone: ZoneType | null;
  count: number;
}

/**
 * 相手先ごとの内訳を作る（§3-4）。`tracesForBuilding` が返す生のトリップ列から、
 * 建物 b を基準に「出発中（departing）」「向かっている（arriving）」を仕分けたうえで、
 * 同じ相手先ごとにまとめて件数を数える。
 *
 * home 判定は建物ID（`homeBuildingId`）、相手（counterpart）の位置は「home でない方の
 * 端点」で決まる——`TripTrace` は復路でも home/dest の意味を入れ替えない
 * （`trace.ts` の規約）ので、home 判定さえ付けば leg を見ずに一意に決まる。
 *
 * `zoneOf` を注入するのは、この関数を `GameState` 全体に依存させず（`getCurrentWorld`
 * を持ち回らず）純粋関数としてテストできるようにするため（`reasonsFor` と同じ考え方）。
 */
export function breakdownByCounterpart(
  traces: readonly TripTrace[],
  b: { id: number; pos: TilePos },
  zoneOf: (pos: TilePos) => ZoneType | null,
): { departing: CounterpartBreakdown[]; arriving: CounterpartBreakdown[] } {
  const departing = new Map<string, CounterpartBreakdown>();
  const arriving = new Map<string, CounterpartBreakdown>();

  for (const trace of traces) {
    const isHome = trace.homeBuildingId === b.id;
    const isDest = samePos(trace.destPos, b.pos);
    if (!isHome && !isDest) continue; // tracesForBuilding のフィルタ上、通常は起きない
    const goingOut = trace.leg === 'outbound' ? isHome : isDest;
    const counterpartPos = isHome ? trace.destPos : trace.homePos;
    const bucket = goingOut ? departing : arriving;
    const key = tileKey(counterpartPos.x, counterpartPos.y);
    const existing = bucket.get(key);
    if (existing) existing.count += 1;
    else bucket.set(key, { pos: counterpartPos, zone: zoneOf(counterpartPos), count: 1 });
  }

  const byCountDesc = (list: CounterpartBreakdown[]) =>
    // 件数の多い相手を上に。同数はタイル座標で安定させる（表示がガタつかないように）
    list.sort(
      (a, c) => c.count - a.count || tileKey(a.pos.x, a.pos.y).localeCompare(tileKey(c.pos.x, c.pos.y)),
    );

  return {
    departing: byCountDesc([...departing.values()]),
    arriving: byCountDesc([...arriving.values()]),
  };
}

type Inspected =
  | { kind: 'building'; tile: TilePos; b: BuildingSnapshot }
  | {
      kind: 'road';
      tile: TilePos;
      congestion: number;
      /**
       * 優先道路の設定（`docs/m4-ui-design.md` §1.6）。孤立した直交T字・十字交差点
       * （`orthogonalIntersectionAt`）でないタイルは `undefined`（＝行を出さない）。
       * `null` は「交差点だが優先未設定」。
       */
      intersectionAxis: IntersectionAxis | null | undefined;
    }
  | { kind: 'land'; tile: TilePos; terrain: TileKind; zone: ZoneType | null; roadAccess: boolean }
  | { kind: 'outside'; tile: TilePos }
  | {
      kind: 'vehicle';
      trace: TripTrace;
      origin: { pos: TilePos; zone: ZoneType | null };
      destination: { pos: TilePos; zone: ZoneType | null };
    };

function samePos(a: TilePos, b: TilePos): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * 選択タイルの詳細を読む。**state は読むだけ**（`src/game/current.ts` の規約）。
 * 建物オブジェクトの参照を持ち回すとレンダー中に値が動くので、値をコピーして返す。
 */
function inspect(tile: TilePos): Inspected | null {
  const world = getCurrentWorld();
  if (!world) return null;
  const { state, congestion } = world;
  const { grid } = state;

  const terrain = terrainAt(grid, tile.x, tile.y);
  if (terrain === undefined) return { kind: 'outside', tile };

  const id = buildingIdAt(grid, tile.x, tile.y);
  const b = id === undefined ? undefined : state.buildings.find((x) => x.id === id);
  if (b) {
    const traces = tracesForBuilding(state, b.id, state.vehicles.length);
    let departingVehicles = 0;
    let arrivingVehicles = 0;
    for (const trace of traces) {
      const departing =
        trace.leg === 'outbound' ? trace.homeBuildingId === b.id : samePos(trace.destPos, b.pos);
      const arriving =
        trace.leg === 'outbound' ? samePos(trace.destPos, b.pos) : trace.homeBuildingId === b.id;
      if (departing) departingVehicles++;
      if (arriving) arrivingVehicles++;
    }
    const zoneOf = (pos: TilePos): ZoneType | null => {
      const counterpartId = buildingIdAt(grid, pos.x, pos.y);
      const counterpart =
        counterpartId === undefined
          ? undefined
          : state.buildings.find((x) => x.id === counterpartId);
      return counterpart?.zone ?? null;
    };
    const { departing: departingBreakdown, arriving: arrivingBreakdown } = breakdownByCounterpart(
      traces,
      b,
      zoneOf,
    );
    return {
      kind: 'building',
      tile,
      b: {
        zone: b.zone,
        occupied: b.occupied,
        satisfaction: b.satisfaction,
        lowSatisfactionDays: b.lowSatisfactionDays,
        tripsOkToday: b.tripsOkToday,
        tripsFailToday: b.tripsFailToday,
        stock: b.stock,
        output: b.output,
        departingVehicles,
        arrivingVehicles,
        departingBreakdown,
        arrivingBreakdown,
      },
    };
  }

  if (hasRoad(grid, tile.x, tile.y)) {
    // 「交通」ツールと同じ判定関数を使う（UIで検証を書き直さない）。読むだけなので、
    // ここでの呼び出しは canApplyOp の代わりにはしない（変更はしない・§1.6）
    const isIntersection = orthogonalIntersectionAt(grid, tile.x, tile.y) !== null;
    const intersectionAxis = isIntersection
      ? (state.intersectionPriorities?.[tileKey(tile.x, tile.y)] ?? null)
      : undefined;
    return {
      kind: 'road',
      tile,
      congestion: congestionAt(congestion, tile.x, tile.y),
      intersectionAxis,
    };
  }

  return {
    kind: 'land',
    tile,
    terrain,
    zone: zoneAt(grid, tile.x, tile.y),
    roadAccess: hasRoadAccess(grid, tile.x, tile.y, ROAD.ROAD_ACCESS_DISTANCE),
  };
}

function inspectVehicle(vehicleId: number): Inspected | null {
  const world = getCurrentWorld();
  if (!world) return null;
  const trace = traceVehicle(world.state, vehicleId);
  if (!trace) return null;
  const originPos = trace.leg === 'outbound' ? trace.homePos : trace.destPos;
  const destinationPos = trace.leg === 'outbound' ? trace.destPos : trace.homePos;
  const zoneAtPos = (pos: TilePos): ZoneType | null =>
    world.state.buildings.find((building) => samePos(building.pos, pos))?.zone ?? null;
  return {
    kind: 'vehicle',
    trace,
    origin: { pos: originPos, zone: zoneAtPos(originPos) },
    destination: { pos: destinationPos, zone: zoneAtPos(destinationPos) },
  };
}

// ---------------------------------------------------------------------------
// 満足度が「いま」動いている理由
// ---------------------------------------------------------------------------

interface Reason {
  /** `inspector.*` のキー（ラベルは `<key>`、説明は `<key>Link`） */
  key: string;
  /** 何台ぶんか（回数で効くものだけ） */
  count?: number;
  /** 満足度への影響量 */
  delta: number;
  /** true なら「/日」で効く（回数ではなく毎日） */
  perDay: boolean;
  /** 説明文に埋める値 */
  params: Record<string, string | number>;
}

/**
 * 満足度の増減の内訳は sim に記録が無い（建物2,000棟ぶんの履歴配列は
 * セーブとメモリを膨らませるので持たせない、という設計判断）。
 * 代わりに `tripsOkToday` / `tripsFailToday` / `stock` / `satisfaction` から言い当てる。
 * 係数はすべて `GROWTH` から引くので、balance.ts を触れば表示も追従する。
 */
function reasonsFor(b: BuildingSnapshot): Reason[] {
  if (!b.occupied) return [];
  const out: Reason[] = [];

  if (b.tripsOkToday > 0) {
    out.push({
      key: 'reasonTripOk',
      count: b.tripsOkToday,
      delta: b.tripsOkToday * GROWTH.SATISFACTION_TRIP_SUCCESS,
      perDay: false,
      params: { step: GROWTH.SATISFACTION_TRIP_SUCCESS },
    });
  }
  if (b.tripsFailToday > 0) {
    out.push({
      key: 'reasonTripFail',
      count: b.tripsFailToday,
      delta: b.tripsFailToday * GROWTH.SATISFACTION_TRIP_FAIL,
      perDay: false,
      params: { step: GROWTH.SATISFACTION_TRIP_FAIL },
    });
  }
  if (b.zone === 'commercial' && (b.stock ?? 0) === 0) {
    out.push({
      key: 'reasonOutOfStock',
      delta: GROWTH.SATISFACTION_OUT_OF_STOCK,
      perDay: true,
      params: {},
    });
  }

  // 毎日 SATISFACTION_START へ回帰する。ちょうど 50 なら動かないので出さない
  const diff = GROWTH.SATISFACTION_START - b.satisfaction;
  if (diff !== 0) {
    const step = Math.min(Math.abs(diff), GROWTH.SATISFACTION_REGRESSION);
    out.push({
      key: 'reasonRegress',
      delta: diff > 0 ? step : -step,
      perDay: true,
      params: {
        start: GROWTH.SATISFACTION_START,
        step: GROWTH.SATISFACTION_REGRESSION,
      },
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 表示部品
// ---------------------------------------------------------------------------

function signed(n: number): string {
  const v = Math.round(n * 100) / 100;
  return v > 0 ? `+${v}` : `${v}`;
}

/**
 * 優先道路の表示文言（`docs/m4-ui-design.md` §1.6）。「交通」ツールのトーストと
 * 同じ文言（`traffic.axis*`）を再利用する。変更はここからできない（読むだけ）。
 */
function axisLabel(axis: IntersectionAxis | null): string {
  if (axis === 'horizontal') return t('traffic.axisHorizontal');
  if (axis === 'vertical') return t('traffic.axisVertical');
  return t('traffic.axisNone');
}

/** 「この数字がどこに繋がるか」の一文。数字だけで終わらせないための必須要素 */
function Link({ text }: { text: string }) {
  return <p className="ins-link">{text}</p>;
}

function Row({ label, value, link }: { label: string; value: string; link?: string }) {
  return (
    <div className="ins-row">
      <div className="ins-row-main">
        <span className="ins-row-label">{label}</span>
        <span className="ins-row-value">{value}</span>
      </div>
      {link ? <Link text={link} /> : null}
    </div>
  );
}

function SatisfactionBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone =
    value < GROWTH.ABANDON_THRESHOLD
      ? 'bad'
      : value < GROWTH.SATISFACTION_START
        ? 'mid'
        : 'good';
  return (
    <div className="ins-bar">
      <div className={`ins-bar-fill ins-bar-${tone}`} style={{ width: `${pct}%` }} />
      {/* 退去ラインを目盛りとして重ねる。数字だけだと「30 が危ない」と読み取れない */}
      <div className="ins-bar-mark" style={{ left: `${GROWTH.ABANDON_THRESHOLD}%` }} />
    </div>
  );
}

function SatisfactionSection({ b }: { b: BuildingSnapshot }) {
  const reasons = reasonsFor(b);
  return (
    <>
      <div className="ins-section">
        <div className="ins-row-main">
          <span className="ins-row-label">{t('inspector.satisfaction')}</span>
          <span className="ins-metric">{Math.round(b.satisfaction)}</span>
        </div>
        <SatisfactionBar value={b.satisfaction} />
        <Link text={tp('inspector.satisfactionScale', { start: GROWTH.SATISFACTION_START })} />
        <Row
          label={t('inspector.abandonLine')}
          value={tp('inspector.abandonLineValue', {
            threshold: GROWTH.ABANDON_THRESHOLD,
            days: GROWTH.ABANDON_DAYS,
          })}
          link={t('inspector.abandonLink')}
        />
        {b.occupied && b.lowSatisfactionDays > 0 ? (
          <p className="ins-warn">
            {tp('inspector.abandonWarning', {
              n: b.lowSatisfactionDays,
              days: GROWTH.ABANDON_DAYS,
            })}
          </p>
        ) : null}
      </div>

      <div className="ins-section">
        <h4 className="ins-heading">{t('inspector.reasonsTitle')}</h4>
        {reasons.length === 0 ? (
          <p className="ins-quiet">{t('inspector.reasonNone')}</p>
        ) : (
          reasons.map((r) => (
            <div className="ins-row" key={r.key}>
              <div className="ins-row-main">
                <span className="ins-row-label">
                  {t(`inspector.${r.key}`)}
                  {r.count !== undefined ? (
                    <span className="ins-count">
                      {' '}
                      {r.count}
                      {t('inspector.unitCars')}
                    </span>
                  ) : null}
                </span>
                <span className={`ins-delta ${r.delta >= 0 ? 'ins-up' : 'ins-down'}`}>
                  {signed(r.delta)}
                  {r.perDay ? t('inspector.unitPerDay') : ''}
                </span>
              </div>
              <Link text={tp(`inspector.${r.key}Link`, r.params)} />
            </div>
          ))
        )}
        <p className="ins-quiet">{t('inspector.todayNote')}</p>
      </div>
    </>
  );
}

function StockSection({ b }: { b: BuildingSnapshot }) {
  if (b.zone === 'commercial') {
    return (
      <div className="ins-section">
        <Row
          label={t('inspector.stock')}
          value={`${Math.round(b.stock ?? 0)} / ${LOGISTICS.STOCK_MAX}`}
          link={tp('inspector.stockLink', {
            consume: LOGISTICS.CONSUME_PER_DAY,
            penalty: GROWTH.SATISFACTION_OUT_OF_STOCK,
          })}
        />
        <Row
          label={t('inspector.restockLine')}
          value={`${LOGISTICS.RESTOCK_THRESHOLD}`}
          link={t('inspector.restockLink')}
        />
      </div>
    );
  }
  if (b.zone === 'industrial') {
    return (
      <div className="ins-section">
        <Row
          label={t('inspector.output')}
          value={`${Math.round(b.output ?? 0)} / ${LOGISTICS.STOCK_MAX}`}
          link={tp('inspector.outputLink', {
            prod: LOGISTICS.PROD_PER_DAY,
            max: LOGISTICS.STOCK_MAX,
          })}
        />
        <Row
          label={t('inspector.shipPerTruck')}
          value={`${LOGISTICS.TRUCK_LOAD}`}
          link={tp('inspector.shipLink', { min: LOGISTICS.SUPPLY_MIN_OUTPUT })}
        />
      </div>
    );
  }
  return null;
}

function EffectsSection({ b }: { b: BuildingSnapshot }) {
  return (
    <div className="ins-section">
      <h4 className="ins-heading">{t('inspector.effectsTitle')}</h4>
      {!b.occupied ? <p className="ins-quiet">{t('inspector.effectVacant')}</p> : null}

      {b.zone === 'residential' ? (
        <>
          <Row
            label={t('inspector.effectPopulation')}
            value={`${GROWTH.POP_PER_BUILDING}${t('inspector.unitPeople')}`}
            link={t('inspector.effectPopulationLink')}
          />
          <Row
            label={t('inspector.effectWorkers')}
            value={`${GROWTH.POP_PER_BUILDING}${t('inspector.unitPeople')}`}
            link={t('inspector.effectWorkersLink')}
          />
          <Row
            label={t('inspector.effectTax')}
            value={`${ECONOMY.TAX_RESIDENTIAL}${t('inspector.unitPerDay')}`}
            link={t('inspector.effectTaxLink')}
          />
        </>
      ) : null}

      {b.zone === 'commercial' ? (
        <>
          <Row
            label={t('inspector.effectJobs')}
            value={`${GROWTH.JOBS_PER_COMMERCIAL}${t('inspector.unitPeople')}`}
            link={t('inspector.effectJobsLink')}
          />
          <Row
            label={t('inspector.effectTax')}
            value={`${ECONOMY.TAX_COMMERCIAL}${t('inspector.unitPerDay')}`}
            link={t('inspector.effectTaxLink')}
          />
          <Row
            label={t('inspector.effectDemandC')}
            value={`${DEMAND.POP_PER_COMMERCIAL}${t('inspector.unitPeople')} → 1${t('inspector.unitBuildings')}`}
            link={tp('inspector.effectDemandCLink', { pop: DEMAND.POP_PER_COMMERCIAL })}
          />
        </>
      ) : null}

      {b.zone === 'industrial' ? (
        <>
          <Row
            label={t('inspector.effectJobs')}
            value={`${GROWTH.JOBS_PER_INDUSTRIAL}${t('inspector.unitPeople')}`}
            link={t('inspector.effectJobsLink')}
          />
          <Row
            label={t('inspector.effectTax')}
            value={`${ECONOMY.TAX_INDUSTRIAL}${t('inspector.unitPerDay')}`}
            link={t('inspector.effectTaxLink')}
          />
          <Row
            label={t('inspector.effectDemandI')}
            value={`1${t('inspector.unitBuildings')} → ${DEMAND.INDUSTRIAL_PER_COMMERCIAL}${t('inspector.unitBuildings')}`}
            link={tp('inspector.effectDemandILink', {
              ratio: DEMAND.INDUSTRIAL_PER_COMMERCIAL,
            })}
          />
        </>
      ) : null}
    </div>
  );
}

function placeLabel(zone: ZoneType | null): string {
  return zone ? t(`zone.${zone}`) : t('trace.place');
}

/**
 * 相手先ごとの内訳（§3-4）。「出発中 N台 / 向かっている M台」の下に、
 * 相手がどこかを1行ずつ添える。0件なら何も出さない（車がいない建物で行が
 * 空のまま残ると寂しいだけでなく「壊れているのでは」と誤解されるため）。
 */
function CounterpartList({
  items,
  direction,
}: {
  items: CounterpartBreakdown[];
  direction: 'departing' | 'arriving';
}) {
  if (items.length === 0) return null;
  const key = direction === 'departing' ? 'counterpartTo' : 'counterpartFrom';
  return (
    <ul className="ins-counterpart-list">
      {items.map((item) => (
        <li key={tileKey(item.pos.x, item.pos.y)} className="ins-counterpart-row">
          {tp(`trace.${key}`, {
            place: placeLabel(item.zone),
            x: item.pos.x,
            y: item.pos.y,
            count: item.count,
          })}
        </li>
      ))}
    </ul>
  );
}

function VehicleTraceSection({ data }: { data: Extract<Inspected, { kind: 'vehicle' }> }) {
  return (
    <div className="ins-section ins-trace-section">
      <p className="ins-trace-route">
        {tp('trace.route', {
          from: placeLabel(data.origin.zone),
          fromX: data.origin.pos.x,
          fromY: data.origin.pos.y,
          to: placeLabel(data.destination.zone),
          toX: data.destination.pos.x,
          toY: data.destination.pos.y,
        })}
      </p>
      <p className="ins-trace-timing">
        {tp('trace.timing', {
          seconds: Math.floor(data.trace.elapsedTicks / TIME.TICKS_PER_SECOND),
          tiles: data.trace.remainingTiles,
        })}
      </p>
    </div>
  );
}

function Body({ data }: { data: Inspected }) {
  if (data.kind === 'vehicle') return <VehicleTraceSection data={data} />;

  if (data.kind === 'building') {
    return (
      <>
        <div className="ins-section">
          <Row
            label={t('trace.vehicles')}
            value={tp('trace.buildingCounts', {
              departing: data.b.departingVehicles,
              arriving: data.b.arrivingVehicles,
            })}
          />
          <CounterpartList items={data.b.departingBreakdown} direction="departing" />
          <CounterpartList items={data.b.arrivingBreakdown} direction="arriving" />
        </div>
        <SatisfactionSection b={data.b} />
        <StockSection b={data.b} />
        <EffectsSection b={data.b} />
      </>
    );
  }

  if (data.kind === 'road') {
    return (
      <div className="ins-section">
        <Row
          label={t('inspector.congestion')}
          value={`${Math.round(data.congestion * 100)}%`}
          link={t('inspector.congestionLink')}
        />
        <Row
          label={t('inspector.upkeep')}
          value={`${ECONOMY.UPKEEP_ROAD_PER_DAY}${t('inspector.unitPerDay')}`}
          link={t('inspector.upkeepLink')}
        />
        {data.intersectionAxis !== undefined ? (
          <Row label={t('inspector.intersection')} value={axisLabel(data.intersectionAxis)} />
        ) : null}
      </div>
    );
  }

  if (data.kind === 'land') {
    return (
      <div className="ins-section">
        <Row label={t('inspector.terrain')} value={t(`terrain.${data.terrain}`)} />
        <Row
          label={t('inspector.roadAccess')}
          value={data.roadAccess ? t('inspector.roadAccessOk') : t('inspector.roadAccessNone')}
          link={tp('inspector.roadAccessLink', { dist: ROAD.ROAD_ACCESS_DISTANCE })}
        />
      </div>
    );
  }

  return (
    <div className="ins-section">
      <p className="ins-quiet">{t('inspector.outsideLink')}</p>
    </div>
  );
}

/** 見出し（種別 + 入居/退去） */
function titleOf(data: Inspected): { title: string; badge: string | null } {
  if (data.kind === 'vehicle') {
    return {
      title: tp('trace.vehicleTitle', {
        icon: t(`trace.kind.${data.trace.kind}`),
        status: t(`trace.status.${data.trace.status}`),
      }),
      badge: t(`trace.leg.${data.trace.leg}`),
    };
  }
  if (data.kind === 'building') {
    return {
      title: t(`zone.${data.b.zone}`),
      badge: data.b.occupied ? t('inspector.occupied') : t('inspector.vacant'),
    };
  }
  if (data.kind === 'road') return { title: t('inspector.road'), badge: null };
  if (data.kind === 'land') {
    return {
      title: data.zone ? t(`zone.${data.zone}`) : t('inspector.emptyLand'),
      badge: data.zone ? t('inspector.notBuiltYet') : t('inspector.unzoned'),
    };
  }
  return { title: t('inspector.outside'), badge: null };
}

// ---------------------------------------------------------------------------

export function Inspector() {
  const selection = useUiStore((s) => s.selection);
  const selectedVehicleId = useUiStore((s) => s.selectedVehicleId);
  const setSelection = useUiStore((s) => s.setSelection);
  const setSelectedVehicleId = useUiStore((s) => s.setSelectedVehicleId);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setSelectedVehicleId(null);
  }, [setSelectedVehicleId, setSelection]);

  // ツールを切り替えたときの選択のクリアは `useUiStore`（setTool/setZone/setRoadMode）が
  // 持つ（`docs/m5-plan.md` §3-2）。分析ツール以外では `setSelection` 自体が非分析ツール中の
  // 書き込みを弾くので、selection は分析ツール中しか非nullにならない——ここで
  // tool を見て二重にクリアする必要はない。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Escape') clearSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection]);

  // 選択中だけ 250ms ごとに読み直す（`src/game/current.ts` の規約）。
  // 選択が無いときはタイマーを持たないので、通常プレイ中の負荷はゼロ
  const [pulse, setPulse] = useState(0);
  const active = selection !== null || selectedVehicleId !== null;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setPulse((v) => v + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [active]);

  const data = useMemo(
    () =>
      selectedVehicleId !== null
        ? inspectVehicle(selectedVehicleId)
        : selection
          ? inspect(selection)
          : null,
    // pulse は「読み直すきっかけ」。値そのものは使わない
    [selectedVehicleId, selection, pulse],
  );

  if (!data) return null;
  const { title, badge } = titleOf(data);

  return (
    <div className="ins-slot">
      <section className="ins-card">
        <header className="ins-head">
          <div className="ins-title">
            <span className="ins-title-main">{title}</span>
            {badge ? <span className="ins-badge">{badge}</span> : null}
          </div>
          {data.kind !== 'vehicle' ? (
            <span className="ins-pos">
              {data.tile.x}, {data.tile.y}
            </span>
          ) : null}
          <button
            type="button"
            className="ins-close"
            aria-label={t('inspector.close')}
            onClick={clearSelection}
          >
            ×
          </button>
        </header>
        <div className="ins-body">
          <Body data={data} />
        </div>
      </section>
    </div>
  );
}
