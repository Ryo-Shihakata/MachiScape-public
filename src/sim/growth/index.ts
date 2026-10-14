/**
 * 需要・発展（実装書 §8）。
 *
 * 入居は60tickごと、それ以外は1ゲーム日に1回、`pipeline.ts` が定める順で呼ばれる。
 *
 * このモジュールは「入居間隔ごと・日次の状態遷移」を担当する。
 * tick 単位の出来事（トリップの成功/失敗による満足度の増減、トラックの配送）は
 * 交通側（`sim/traffic/`）が `building.satisfaction` / `stock` / `output` を
 * 直接書き換える。ここで二重に計上しないこと。
 */

import { DEMAND, EXPLAIN, GROWTH, LOGISTICS, MOVE_IN, ROAD, SPACE, TIME } from '../balance';
import { buildingIdAt, facilityIdAt, hasRoad, hasRoadAccess, terrainAt, zoneAt } from '../grid';
import { satisfactionFloorAt } from '../facility';
import { chance, weightedPick } from '../rng';
import type {
  BuildingStats,
  ComputeDemand,
  Demand,
  ProcessLogistics,
  ProcessMoveIn,
  UpdateSatisfaction,
} from '../pipeline';
import { tileKey, type Building, type GameState, type Grid, type ZoneType } from '../types';

const CS = SPACE.CHUNK_SIZE;
const MOVE_IN_INTERVALS_PER_DAY = TIME.TICKS_PER_DAY / MOVE_IN.INTERVAL_TICKS;

/**
 * 区画タイプの走査順。決定論のため、どこで回すときもこの順に固定する
 * （`Object.keys` の順に頼らない）。
 */
const ZONE_ORDER: readonly ZoneType[] = ['residential', 'commercial', 'industrial'];

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function emptyZoneCounts(): Record<ZoneType, number> {
  return { residential: 0, commercial: 0, industrial: 0 };
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

/**
 * 日次処理の冒頭で1回だけ作る建物の集計（実装書 §8.1）。
 * 各モジュールが `state.buildings` を数え直さないための共有スナップショット。
 */
export function computeBuildingStats(state: GameState): BuildingStats {
  const occupied = emptyZoneCounts();
  const built = emptyZoneCounts();

  for (const b of state.buildings) {
    // built は入居の有無を問わない（実装書 §8.1: 過剰建設の抑制のため）
    built[b.zone]++;
    if (b.occupied) occupied[b.zone]++;
  }

  // 「直近1日」の失敗率を使う（実装書 §8.1）。
  // 累計比にすると序盤の失敗が永久に需要を押し下げ、プレイヤーが道路を直しても
  // 街が二度と回復しない（実測で人口0のまま100日戻らなかった）。
  // まだ1日も終わっていない間は当日の集計で代用する。
  const p = state.progress;
  const trips = p.tripsLastDay > 0 ? p.tripsLastDay : p.tripsToday;
  const failed = p.tripsLastDay > 0 ? p.failedLastDay : p.failedToday;
  const recentTripFailRate = clamp(failed / Math.max(1, trips), 0, 1);

  return {
    occupied,
    built,
    population: occupied.residential * GROWTH.POP_PER_BUILDING,
    recentTripFailRate,
  };
}

/**
 * 街の処理率（`docs/m6-plan.md` §2 W2）= 完了した移動 ÷ 発生すべきだった移動。
 *
 * 分母に**上限で出発できなかったぶん（`unserved`）を含めるのが要点**。
 * 含めないと、渋滞して車が出せなくなるほど分母が小さくなり、
 * **道路網が悪いほど数字が良く見える**という逆転が起きる。
 *
 * まだ1日も終わっていない間は当日の集計で代用する（`computeBuildingStats` と同じ扱い）。
 *
 * **絶対値をマイルストーンの合格条件に使ってはいけない。** 実測すると、密な道路網でも
 * スカスカな道路網でもこの値は 61% / 62% とほとんど同じになる（`docs/m6-plan.md` §1-4）。
 * 街は「移動時間が同じくらいになるまで」成長して止まるので、**道路網の質は処理率ではなく
 * 街の大きさに現れる**。使ってよいのは「昨日より悪くなったか」という変化の方向と、
 * 建物ごとの内訳（どの住宅が出られずにいるか）。
 */
export function serviceRate(state: GameState): number {
  const p = state.progress;
  const useLastDay = p.tripsLastDay > 0 || p.unservedLastDay > 0;
  const trips = useLastDay ? p.tripsLastDay : p.tripsToday;
  const failed = useLastDay ? p.failedLastDay : p.failedToday;
  const unserved = useLastDay ? p.unservedLastDay : p.unservedToday;

  const demanded = trips + unserved;
  if (demanded <= 0) return 1; // 誰も動く必要がない街は「捌けている」扱い
  return clamp((trips - failed) / demanded, 0, 1);
}

// ---------------------------------------------------------------------------
// §8.1 需要バー
// ---------------------------------------------------------------------------

/**
 * 需要を構成する「足し合わせると需要値になる項」（実装書 §8.1 の数式を項ごとに分解したもの）。
 *
 * `computeDemand` と `explainDemand` はどちらもこれを使う。**数式をここに1本化するのが要点**で、
 * 表示側が係数（`DEMAND.R_JOB_BALANCE_WEIGHT` 等）を写し取ると、バランス調整のときに
 * 表示だけが古くなって「画面の説明と実挙動が違う」という最悪の状態になる。
 */
interface DemandTerms {
  /** 街全体の働き口の数 */
  jobs: number;
  /** 働ける住民の数 */
  workers: number;
  /** 直近1日のトリップ失敗率 0..1 */
  failRate: number;
  residential: {
    /** 下駄。街が空でも住宅が建ち始めるために要る */
    base: number;
    /** 働き口の過不足。jobs > workers なら正 */
    jobBalance: number;
    /** 目的地に着けなかった車のペナルティ。常に 0 以下 */
    tripFail: number;
  };
  commercial: {
    /** 人口が求めている店の数ぶん（正） */
    demandedByPopulation: number;
    /** すでに営業している店の数ぶん（負） */
    suppliedByShops: number;
  };
  industrial: {
    /** 店が求めている工場の数ぶん（正） */
    demandedByShops: number;
    /** すでに稼働している工場の数ぶん（負） */
    suppliedByFactories: number;
  };
}

function demandTerms(stats: BuildingStats): DemandTerms {
  const jobs =
    GROWTH.JOBS_PER_COMMERCIAL * stats.occupied.commercial +
    GROWTH.JOBS_PER_INDUSTRIAL * stats.occupied.industrial;
  const workers = GROWTH.POP_PER_BUILDING * stats.occupied.residential;

  // 需要は「いま足りているか」を表すので、建っているだけの空き店舗ではなく
  // **入居済み**の棟数と比べる。
  //
  // 実装書 §8.1 は built（退去済みを含む）と書いているが、それだと店が一度潰れると
  // 需要が負のままになり、§8.3 の「条件が直れば再入居する」が永久に起きない
  // （実測: 商業が全滅して二度と戻らなかった）。
  // 過剰建設の抑制は、入居のときに空き物件を新築より優先することで達成する（§8.2）。
  return {
    jobs,
    workers,
    failRate: stats.recentTripFailRate,
    residential: {
      base: DEMAND.R_BASE,
      // **比率で見る。** 差（jobs − workers）だと街が大きくなるほど差も大きくなり、
      // 人口に固定の上限が生まれる（実測で142人で頭打ちになっていた）。
      // 働き手が0の間（街の立ち上がり）は不均衡なしとみなして下駄をそのまま活かす。
      jobBalance:
        DEMAND.R_JOB_BALANCE_WEIGHT *
        ((workers === 0 ? DEMAND.R_JOB_TARGET_RATIO : jobs / workers) - DEMAND.R_JOB_TARGET_RATIO) *
        100,
      tripFail: -DEMAND.R_TRIP_FAIL_PENALTY * stats.recentTripFailRate,
    },
    commercial: {
      demandedByPopulation:
        (stats.population / DEMAND.POP_PER_COMMERCIAL) * DEMAND.PER_MISSING_BUILDING,
      suppliedByShops: -stats.occupied.commercial * DEMAND.PER_MISSING_BUILDING,
    },
    industrial: {
      demandedByShops:
        stats.occupied.commercial * DEMAND.INDUSTRIAL_PER_COMMERCIAL * DEMAND.PER_MISSING_BUILDING,
      suppliedByFactories: -stats.occupied.industrial * DEMAND.PER_MISSING_BUILDING,
    },
  };
}

/** 区画ごとの項をクランプ前の需要値へ畳む */
function rawDemand(terms: DemandTerms): Demand {
  const r = terms.residential;
  const c = terms.commercial;
  const i = terms.industrial;
  return {
    residential: r.base + r.jobBalance + r.tripFail,
    commercial: c.demandedByPopulation + c.suppliedByShops,
    industrial: i.demandedByShops + i.suppliedByFactories,
  };
}

/**
 * RCI 需要を再計算する（実装書 §8.1）。
 * 各需要は**計算時点で** [-100, 100] にクランプし、表示にも §8.2 にも同じ値を使う。
 */
export const computeDemand: ComputeDemand = (_state, stats): Demand => {
  const raw = rawDemand(demandTerms(stats));
  return {
    residential: clamp(raw.residential, DEMAND.MIN, DEMAND.MAX),
    commercial: clamp(raw.commercial, DEMAND.MIN, DEMAND.MAX),
    industrial: clamp(raw.industrial, DEMAND.MIN, DEMAND.MAX),
  };
};

// ---------------------------------------------------------------------------
// §8.1 需要の内訳（インスペクタ・需要バーの説明用）
// ---------------------------------------------------------------------------

/**
 * 内訳の1項目を識別するキー。UI はこれを文字列テーブルの添字に使う
 * （`t('demand.contribution.<key>')`）。日本語の文言は sim には置かない。
 */
export type ContributionKey =
  'rBase' | 'rJobBalance' | 'rTripFail' | 'cPopulation' | 'cShops' | 'iShops' | 'iFactories';

/** 効き方の段階。UI はこれを「++ / + / − / −−」に写すだけにする */
export type ContributionLevel = -2 | -1 | 0 | 1 | 2;

export interface DemandContribution {
  key: ContributionKey;
  /** この項が需要値に足している量（負なら押し下げている） */
  value: number;
  level: ContributionLevel;
}

export interface ZoneDemandExplanation {
  /** クランプ前の合計。`contributions` の value の総和と一致する */
  raw: number;
  /** クランプ後の需要値。`computeDemand` の返り値と一致する */
  value: number;
  /** クランプで頭打ちになっているか（＝これ以上効かない状態） */
  clamped: boolean;
  contributions: DemandContribution[];
}

/**
 * 需要が「何で決まっているか」の内訳（`docs/m3-plan.md` §4 の 3-3）。
 *
 * `Demand` にこれを混ぜないのは、`Demand` が `processMoveIn` も受け取る契約
 * （`pipeline.ts`）であり、表示専用の値を入れると sim の契約が UI に引きずられるため。
 *
 * `stats` を省略すると `computeBuildingStats` で作る（UI が呼びやすいように）。
 */
export function explainDemand(
  state: GameState,
  stats: BuildingStats = computeBuildingStats(state),
): DemandExplanation {
  const terms = demandTerms(stats);
  const raw = rawDemand(terms);

  const zone = (
    rawValue: number,
    parts: ReadonlyArray<readonly [ContributionKey, number]>,
  ): ZoneDemandExplanation => {
    const value = clamp(rawValue, DEMAND.MIN, DEMAND.MAX);
    return {
      raw: rawValue,
      value,
      clamped: value !== rawValue,
      contributions: parts.map(([key, v]) => ({ key, value: v, level: contributionLevel(v) })),
    };
  };

  return {
    jobs: terms.jobs,
    workers: terms.workers,
    failRate: terms.failRate,
    population: stats.population,
    occupied: { ...stats.occupied },
    residential: zone(raw.residential, [
      ['rBase', terms.residential.base],
      ['rJobBalance', terms.residential.jobBalance],
      ['rTripFail', terms.residential.tripFail],
    ]),
    commercial: zone(raw.commercial, [
      ['cPopulation', terms.commercial.demandedByPopulation],
      ['cShops', terms.commercial.suppliedByShops],
    ]),
    industrial: zone(raw.industrial, [
      ['iShops', terms.industrial.demandedByShops],
      ['iFactories', terms.industrial.suppliedByFactories],
    ]),
  };
}

export interface DemandExplanation {
  /** 街全体の働き口（= JOBS_PER_COMMERCIAL×商業 + JOBS_PER_INDUSTRIAL×工業） */
  jobs: number;
  /** 働ける住民（= POP_PER_BUILDING×住宅） */
  workers: number;
  /** 直近1日のトリップ失敗率 0..1 */
  failRate: number;
  population: number;
  occupied: Record<ZoneType, number>;
  residential: ZoneDemandExplanation;
  commercial: ZoneDemandExplanation;
  industrial: ZoneDemandExplanation;
}

/**
 * 寄与の強さを段階に落とす。閾値は `EXPLAIN`（balance.ts）に置いてあるので、
 * DEMAND の係数を調整したときに表示の段階も一緒に見直せる。
 */
export function contributionLevel(value: number): ContributionLevel {
  const a = Math.abs(value);
  if (a < EXPLAIN.CONTRIBUTION_NEGLIGIBLE) return 0;
  const strong = a >= EXPLAIN.CONTRIBUTION_STRONG;
  return value > 0 ? (strong ? 2 : 1) : strong ? -2 : -1;
}

// ---------------------------------------------------------------------------
// §8.2 入居
// ---------------------------------------------------------------------------

/** 入居先の候補タイル */
interface VacantTile {
  x: number;
  y: number;
  /** 退去済みの建物が残っているタイルなら、その建物（新築せず再入居させる） */
  existing?: Building;
}

/** そのタイルに建物を置ける地形か。区画を塗った後に道路や地形が変わった場合の保険 */
function isPlaceableTile(grid: Grid, x: number, y: number): boolean {
  const t = terrainAt(grid, x, y);
  if (t === undefined || t === 'mountain' || t === 'water') return false;
  // 区画の上に道路を引くことは applyOp で禁止されていないので、ここで弾く
  return !hasRoad(grid, x, y) && facilityIdAt(grid, x, y) === undefined;
}

/**
 * 空き区画タイルを区画タイプ別に集める。
 *
 * **決定論の要**: 列挙順が実行ごとにブレると同じ seed でも違う建物が建つ。
 * districts の並び（＝購入順）に依存しないよう、チャンクを (cy, cx) 昇順に
 * 並べ替えてから、チャンク内を y → x 昇順で走査する。
 */
function collectVacantTiles(
  state: GameState,
  byId: Map<number, Building>,
): Record<ZoneType, VacantTile[]> {
  const out: Record<ZoneType, VacantTile[]> = {
    residential: [],
    commercial: [],
    industrial: [],
  };

  const chunks = [...state.districts].sort((a, b) => a.cy - b.cy || a.cx - b.cx);

  for (const c of chunks) {
    for (let ly = 0; ly < CS; ly++) {
      for (let lx = 0; lx < CS; lx++) {
        const x = c.cx * CS + lx;
        const y = c.cy * CS + ly;

        const zone = zoneAt(state.grid, x, y);
        if (zone === null) continue;
        if (!isPlaceableTile(state.grid, x, y)) continue;
        // アクセスのない区画タイルには建たない（実装書 §8.2）
        if (!hasRoadAccess(state.grid, x, y, ROAD.ROAD_ACCESS_DISTANCE)) continue;

        const id = buildingIdAt(state.grid, x, y);
        if (id === undefined) {
          out[zone].push({ x, y });
          continue;
        }

        const existing = byId.get(id);
        if (!existing || existing.occupied) continue;
        // 退去後に区画を塗り替えられた建物は、そのままでは別業種になってしまうので触らない
        if (existing.zone !== zone) continue;
        out[zone].push({ x, y, existing });
      }
    }
  }

  return out;
}

/** 新築して入居させる */
function construct(state: GameState, zone: ZoneType, x: number, y: number): void {
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
  if (zone === 'commercial') b.stock = LOGISTICS.STOCK_MAX;
  if (zone === 'industrial') b.output = 0;

  state.buildings.push(b);
  state.grid.buildingIndex[tileKey(x, y)] = b.id;
}

/**
 * 退去済みの建物に新しい住人・店子が入る。
 * 建物は建て直さない（区画も建物も残す＝実装書 §8.3）。
 */
function reoccupy(b: Building): void {
  b.occupied = true;
  b.satisfaction = GROWTH.SATISFACTION_START;
  b.lowSatisfactionDays = 0;
  b.tripsOkToday = 0;
  b.tripsFailToday = 0;
  // 空の棚で再開すると初日に在庫切れペナルティを食らうので、猶予を作り直す。
  // industrial の output は倉庫在庫なので退去中も残したまま引き継ぐ
  if (b.zone === 'commercial') b.stock = LOGISTICS.STOCK_MAX;
}

/**
 * 需要に応じて空き区画へ入居させる（実装書 §8.2）。
 *
 * `stats` は契約（`ProcessMoveIn`）の一部だが v1 では使わない。
 * 入居数は需要だけで決まり、需要の側が既に stats を織り込んでいるため。
 */
export const processMoveIn: ProcessMoveIn = (state, _stats, demand, rng) => {
  const byId = new Map(state.buildings.map((b) => [b.id, b]));
  const vacant = collectVacantTiles(state, byId);

  for (const zone of ZONE_ORDER) {
    const value = demand[zone];
    if (value <= 0) continue;

    const pool = vacant[zone];
    // 空き物件（退去済みの建物）と更地を分け、空き物件から先に埋める。
    // 空きがある限り新築しないので、これが過剰建設の抑制になる（実装書 §8.1 の
    // built による抑制の代わり。built だと一度潰れた店が二度と戻らなかった）。
    const reoccupiable = pool.filter((t) => t.existing);
    const fresh = pool.filter((t) => !t.existing);
    // 端数は確率で扱う。切り捨てるだけだと需要が 1〜9 の帯に入ったときに
    // 毎日ゼロになり、街が永久に止まる（実測で住宅4棟・商業1棟で停止していた）。
    // 確率にすれば期待値は同じまま、需要が小さくてもゆっくり育ち続ける。
    // 日次だったときの期待棟数を、1日あたりの実行回数へ均等に分ける。
    // 端数を各回 chance で扱うことで、需要が一定なら1日合計の期待値は従来と同じになる。
    const exact = value / MOVE_IN.DEMAND_PER_MOVE_IN / MOVE_IN_INTERVALS_PER_DAY;
    let wanted = Math.floor(exact);
    if (chance(rng, exact - wanted)) wanted++;
    const count = Math.min(wanted, pool.length);

    for (let i = 0; i < count; i++) {
      const from = reoccupiable.length > 0 ? reoccupiable : fresh;
      if (from.length === 0) break;
      // 基本重み1の一様抽選。M3 で施設バフ（growthMul）を掛けられるよう
      // 最初から weightedPick を通しておく
      const picked = weightedPick(
        rng,
        from.map(() => MOVE_IN.BASE_WEIGHT),
      );
      if (picked < 0) break;
      const tile = from[picked];
      if (!tile) break;
      // 同じタイルを二度引かないよう取り除く。splice なので残りの順序は保たれる
      from.splice(picked, 1);

      if (tile.existing) reoccupy(tile.existing);
      else construct(state, zone, tile.x, tile.y);
    }
  }
};

// ---------------------------------------------------------------------------
// §7.2 生産・消費（日次の在庫増減のみ）
// ---------------------------------------------------------------------------

/**
 * 工業の生産と商業の消費を1日ぶん進める（実装書 §7.2）。
 *
 * トラックの生成・配送は交通側の担当なのでここでは触らない。
 *
 * NOTE: 実装書 §7.2 は commercial にだけ「(入居済)」と書いているが、
 * ここでは industrial にも入居済み条件を課している。退去した工場が生産を続けると
 * `output ≥ SUPPLY_MIN_OUTPUT` の供給元として使われ続け、退去がペナルティに
 * ならなくなるため。実装書側の表記を揃えるべき。
 */
export const processLogistics: ProcessLogistics = (state) => {
  for (const b of state.buildings) {
    if (!b.occupied) continue;

    if (b.zone === 'industrial') {
      b.output = Math.min(LOGISTICS.STOCK_MAX, (b.output ?? 0) + LOGISTICS.PROD_PER_DAY);
    } else if (b.zone === 'commercial') {
      b.stock = Math.max(0, (b.stock ?? 0) - LOGISTICS.CONSUME_PER_DAY);
    }
  }
};

// ---------------------------------------------------------------------------
// §8.3 満足度と退去
// ---------------------------------------------------------------------------

/**
 * 満足度を1日ぶん更新し、条件を満たした建物を退去させる（実装書 §8.3）。
 *
 * トリップの成功 +1 / 失敗 −4 は交通側が到着・失敗の時点で加算済み。
 * ここが担当するのは日次の回帰・在庫ペナルティ・退去判定だけ。
 *
 * 適用順は「回帰 → 在庫ペナルティ → クランプ → 退去判定」。
 * 退去判定を**適用後**の値で行うのは、プレイヤーが画面で見る値と
 * 連続日数カウンタが一致するようにするため。この順なら
 * 「1日でも閾値以上に戻れば連続日数がリセットされ、退去しない」が成り立つ。
 */
export const updateSatisfaction: UpdateSatisfaction = (state) => {
  for (const b of state.buildings) {
    // 退去済みの建物は住人がいないので何も起きない（再入居時に初期値へ戻る）
    if (!b.occupied) continue;

    // 毎日 SATISFACTION_START に向かって回帰する。行き過ぎないよう差分で頭打ちにする
    const diff = GROWTH.SATISFACTION_START - b.satisfaction;
    if (diff !== 0) {
      const step = Math.min(Math.abs(diff), GROWTH.SATISFACTION_REGRESSION);
      b.satisfaction += diff > 0 ? step : -step;
    }

    // 商業は品切れの日に大きく落ちる
    if (b.zone === 'commercial' && (b.stock ?? 0) === 0) {
      b.satisfaction += GROWTH.SATISFACTION_OUT_OF_STOCK;
    }

    b.satisfaction = clamp(b.satisfaction, GROWTH.SATISFACTION_MIN, GROWTH.SATISFACTION_MAX);
    if (b.zone === 'residential') {
      b.satisfaction = Math.max(b.satisfaction, satisfactionFloorAt(state, b.pos));
    }

    if (b.satisfaction < GROWTH.ABANDON_THRESHOLD) {
      b.lowSatisfactionDays++;
      if (b.lowSatisfactionDays >= GROWTH.ABANDON_DAYS) {
        // 退去。区画も建物も残し、条件が直れば §8.2 が再入居させる
        b.occupied = false;
        b.lowSatisfactionDays = 0;
      }
    } else {
      // 1日でも持ち直したら連続日数はリセットする
      b.lowSatisfactionDays = 0;
    }
  }

  // 「今日の到着/失敗」は日次の集計なので、1日の締めでゼロに戻す
  // （`world.ts` の stepDay が progress.tripsToday を空にするのと同じ考え方）。
  // 退去済みの建物も対象にする: 退去の直前に記録された失敗が翌日まで残ると、
  // インスペクタが「昨日の失敗」を今日の理由として表示してしまう。
  for (const b of state.buildings) {
    b.tripsOkToday = 0;
    b.tripsFailToday = 0;
  }
};

// 調整値はすべて balance.ts へ移設済み（DEMAND / MOVE_IN / GROWTH）
