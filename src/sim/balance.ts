/**
 * ゲームバランス定数の一元管理（実装書 §0）。
 * ここの値はすべて仮の初期値であり、プレイテスト（P0 / M2 / M5）で調整する。
 * **コード中に数値を直書きしないこと。**
 */

/** 通常走行と建物からの合流で共有する、物理距離ベースの基準車間。 */
const MIN_TRAFFIC_HEADWAY_DISTANCE = 0.5;

export const TIME = {
  TICKS_PER_SECOND: 10,
  TICKS_PER_DAY: 600, // 1x で実時間60秒
  SPEEDS: [0, 1, 2, 3] as const,
} as const;

export const SPACE = {
  CHUNK_SIZE: 32,
  TILE_PX: 32, // ズーム1のときの1タイルのピクセル数
  ZOOM_MIN: 0.25,
  ZOOM_MAX: 3,
} as const;

export const MAPGEN = {
  MOUNTAIN_THRESHOLD: 0.78,
  LAKE_THRESHOLD: 0.85,
  FOREST_THRESHOLD: 0.72,
  START_CHUNK_MIN_PLAIN_RATIO: 0.6,
} as const;

export const ROAD = {
  CONGESTION_WEIGHT: 2.0,
  /** 脚の出発後、この時間を超えて辺の先頭付近にいる車だけを迂回候補にする */
  TICKS_STUCK: 100,
  /** spawn と動的迂回を合わせた、1tick の A* 呼び出し上限 */
  PATHFIND_BUDGET_PER_TICK: 5,
  /** 従来の発生量を保つために spawn へ割り当てる、1tick の A* 呼び出し上限 */
  SPAWN_PATHFIND_BUDGET_PER_TICK: 4,
  /** 動的迂回へ割り当てる、1回の判定tickあたりの A* 呼び出し上限 */
  REROUTE_BUDGET_PER_TICK: 1,
  /** 全車の迂回候補を調べる間隔。毎tick最適化せず、反応を意図的に遅らせる */
  REROUTE_CHECK_INTERVAL_TICKS: 20,
  /** 同じ車を再び A* に掛けるまでの待ち時間。失敗した再探索にも適用する */
  REROUTE_COOLDOWN_TICKS: 200,
  /** 残り経路の平均混雑度がこの値以上の車だけを迂回候補にする */
  REROUTE_CONGESTION_THRESHOLD: 0.6,
  /** 混雑度を測る際に見る、残り経路の先頭タイル数。長い経路でも判定コストを一定に保つ */
  REROUTE_SCAN_TILES: 12,
  /** 現経路よりこの割合以上安い経路だけへ乗り換える（0.2 = 20%改善） */
  REROUTE_MIN_IMPROVEMENT: 0.2,
  ROAD_ACCESS_DISTANCE: 2, // 区画・施設が道路から離れてよい最大マンハッタン距離
} as const;

export const TRAFFIC = {
  TRIP_RATE_R: 0.01, // 入居済み住宅1棟あたり毎tickの出発確率
  /**
   * 1棟が同時に道路へ出せる車の上限。**渋滞の暴走を止める背圧そのもの**。
   *
   * これが無いと、画面上の車の数は「発生率 × 1台の生存時間」で決まる。
   * 生存時間は渋滞するほど延びるので、
   *   混む → 1台が長く居座る → 車が増える → もっと混む
   * という正のフィードバックに歯止めが無くなる。実測では発展段階に関わらず
   * 1棟あたり2〜2.6台が路上に出続け（住宅31棟に対し車131台）、
   * 失敗率20%で人口が460人から伸びなくなっていた。**成長の頭打ちは需要式ではなく
   * この暴走が原因だった。**
   *
   * 1にすると「1軒から出た車が帰るまで、その家は次の車を出さない」となり、
   * 車の数が入居棟数に比例して自然に決まる。同じ道路網で人口464→1704まで伸び、
   * 車は131→106に減った（`docs/decisions.md` D7）。
   *
   * 上限に達している間は `TRIP_RATE_R` の抽選そのものを行わない。
   * 抽選してから捨てると乱数の消費量が状況で変わり、決定論の再現性が壊れる。
   */
  MAX_ACTIVE_TRIPS_PER_BUILDING: 1,
  DEST_WEIGHT_COMMERCIAL: 0.6,
  DEST_WEIGHT_INDUSTRIAL: 0.25,
  DEST_WEIGHT_FACILITY: 0.15,
  DISTANCE_FALLOFF: 8, // attraction / (1 + dist / DISTANCE_FALLOFF)
  VMAX: 3, // タイル/秒
  /**
   * 建物中心とアクセス道路中心の間を走る速度（タイル/秒）。
   * 道路上の VMAX より明確に遅くし、私道への出入りを目で追える時間にする。
   */
  ACCESS_SPEED: 0.75,
  CAPACITY: 4, // 1タイルの許容車両数
  /** 幹線道路（ランク2）のタイル容量。2レーンぶん通常道路の2倍にする。 */
  ARTERIAL_CAPACITY_MULTIPLIER: 2,
  /**
   * 前車との最小車間。**単位はタイル（物理距離）**。
   *
   * 以前は「辺の進捗(0..1)の差」だったが、それだと
   *  - 斜めの辺（長さ√2）で実際の間隔が変わる
   *  - 値 0.2 が車体長（自家用車 0.30 / トラック 0.44 タイル）より短く、**必ず重なる**
   * という2つの問題があった（オーナー報告「車間距離が空いていない」）。
   *
   * 物理距離にすることで、辺の長さにも辺の境界にも依存しなくなる。
   * 車体長より確実に長い値にすること。
   */
  MIN_HEADWAY_DISTANCE: MIN_TRAFFIC_HEADWAY_DISTANCE,
  /**
   * 建物から道路へ合流するときに必要な前後それぞれの空き距離。
   * 追従と同じ物差しを使うため、通常走行の最小車間をそのまま基準にする。
   */
  MERGE_GAP_DISTANCE: MIN_TRAFFIC_HEADWAY_DISTANCE,
  /** ギャップが開かなくても強制的に合流して飢餓を防ぐまでの待機 tick 数。 */
  MERGE_MAX_WAIT_TICKS: 30,
  /**
   * 前車を探すときに先読みする辺の数の上限。
   * 停止した列は密なので数辺で足り、上限を設けることで1tickの計算量が一定になる。
   */
  HEADWAY_LOOKAHEAD_EDGES: 4,
  /** 交差点を譲る車が止まる辺上の進捗。1未満なので中心タイルへ進入しない */
  /**
   * 交差点の手前で止まる位置（進入する辺の進捗 0..1）。
   *
   * **0.95 は交差点タイルの中心の直前で、実質「交差点に入ってから止まる」位置だった。**
   * 描画の停止線はタイル境界付近（中心から0.42）に引かれており、半タイル以上ずれていた
   * （オーナー報告「赤線で車が停まるようにして」）。
   * 車は交差点に**入る前**に止まるべきなので、タイル境界のあたりへ下げる。
   *
   * **この値が正（SSOT）で、描画の停止線はここから導出する**
   * （`intersectionStopDistanceFromCenter()`）。片方だけ動かすと表示が嘘になる。
   */
  INTERSECTION_STOP_PROGRESS: 0.55,
  /** 需要が反対軸にあっても、通常の青現示を最低限保持する時間（2秒） */
  SIGNAL_MIN_GREEN_TICKS: 20,
  /**
   * プレイヤー指定の優先軸を保持する最低時間（3秒）。通常軸より長くする一方、
   * INTERSECTION_MAX_YIELD_TICKS 到達時は従側へ譲り、優先指定が飢餓を起こさないようにする。
   */
  SIGNAL_PRIORITY_MIN_GREEN_TICKS: 30,
  /**
   * 優先指定がある交差点で、従側へ譲ったときの最低青（0.5秒）。待っていた列を通しつつ、
   * 優先軸に再び需要があれば通常の青より早く戻して「優先」の効果を保つ。
   */
  SIGNAL_PRIORITY_MINOR_GREEN_TICKS: 5,
  /**
   * 青から反対軸の青へ切り替える間に、両軸の新規進入を止める時間（0.8秒）。
   * 青の最終tickに停止線を越えた低速車が交差点中心まで抜ける時間を確保する。
   */
  SIGNAL_ALL_RED_TICKS: 8,
  /** 非優先側がこのtick数待ったら、優先側に車がいても従側の軸へ切り替えて飢餓を防ぐ */
  INTERSECTION_MAX_YIELD_TICKS: 40,
  CONGESTION_ALPHA: 0.05, // 混雑度EMAの平滑化係数
  TRIP_TIMEOUT: 300, // tick
  DESTINATION_DWELL_TICKS: 45, // 目的地での滞在（4.5秒）
  MAX_VEHICLES: 1500,
} as const;

export const LOGISTICS = {
  PROD_PER_DAY: 60,
  CONSUME_PER_DAY: 20,
  RESTOCK_THRESHOLD: 40,
  SUPPLY_MIN_OUTPUT: 50,
  TRUCK_LOAD: 50,
  STOCK_MAX: 100,
} as const;

/**
 * 需要バーの数式（実装書 §8.1）。
 * ここの係数が街の育ち方をほぼ決めるので、プレイテストで最初に触る場所になる。
 */
export const DEMAND = {
  /** R需要の下駄。街が空でも住宅が建ち始めるために要る */
  R_BASE: 20,
  /**
   * R需要が雇用の**比率**に反応する強さ: 係数 × (jobs/workers − R_JOB_TARGET_RATIO) × 100
   *
   * **差（jobs − workers）ではなく比率にしてある。** 差で見ると、街が大きくなるほど
   * 差そのものが大きくなり、人口に**固定の上限**が生まれる（実測: 人口142で頭打ち）。
   * マイルストーンは人口5000まで続く設計なので、2つ目以降が到達不能になっていた。
   * 比率なら規模に依存しないので、**商業・工業をきちんと足せば伸び続ける**。
   * 成長を止めるのは「産業構成の偏り」と「道路網の失敗率」だけになる。
   */
  R_JOB_BALANCE_WEIGHT: 0.5,
  /**
   * 働き手に対する働き口の目標比。ここを下回ると住宅需要が落ちる。
   *
   * 街が自然に落ち着く構成（商業=人口/POP_PER_COMMERCIAL、工業=商業×INDUSTRIAL_PER_COMMERCIAL）
   * での比率がおよそ 0.44 なので、その近くに置く。0 のとき（商工がゼロ）は
   * `20 + 0.5 × (0 − 0.45) × 100 = −2.5` となり、住宅だけの街は伸びない。
   */
  R_JOB_TARGET_RATIO: 0.45,
  /** R需要のトリップ失敗ペナルティ: 係数 × recentTripFailRate */
  R_TRIP_FAIL_PENALTY: 100,
  /** C需要: 人口この人数につき商業1棟を要求する */
  POP_PER_COMMERCIAL: 16,
  /** I需要: 商業1棟につき工業この棟数を要求する */
  INDUSTRIAL_PER_COMMERCIAL: 0.5,
  /** 「不足棟数 → 需要値」の換算。1棟の不足 = この需要値 */
  PER_MISSING_BUILDING: 10,
  MIN: -100,
  MAX: 100,
} as const;

/**
 * 需要の内訳を「+」「++」の段階で見せるときの境界（`explainDemand` が使う）。
 *
 * ここに置くのは、UI が「どのくらい強く効いているか」を判断するための閾値であり、
 * DEMAND の係数と一緒に動かす値だから。UI 側に書くと、DEMAND を調整したときに
 * 表示の段階だけ取り残されて実挙動とずれる。
 */
export const EXPLAIN = {
  /** |寄与| がこれ以上なら「強い」（++ / −−） */
  CONTRIBUTION_STRONG: 20,
  /** |寄与| がこれ未満なら「効いていない」（表示しない） */
  CONTRIBUTION_NEGLIGIBLE: 0.5,
} as const;

/** 入居まわり（実装書 §8.2） */
export const MOVE_IN = {
  /**
   * 需要この値につき1棟入居する。端数は確率で扱う（切り捨てると街が止まる）。
   * 小さいほど同じ需要から速く建つ＝街の成長が速い。
   *
   * 6 → 4 → 2 と下げてきた。6 のときは5日で7棟しか建たず「塗った区画が埋まらない」
   * という手応えの問題があった。`MAX_ACTIVE_TRIPS_PER_BUILDING` で渋滞の暴走を
   * 止めた後なので、速く建てても交通が破綻せず、道路網の実力どおりの人口で落ち着く。
   *
   * **4 → 2 は `INTERVAL_TICKS` を日次から60tickへ変えたぶんの補償**（M5 §2-2）。
   * 入居を1日10回に割ると、需要が同じ日のうちに10回引き直される。建つそばから
   * 雇用比と失敗率が反映されて需要が下がるので、1日の合計は「朝の需要 ÷ 4」より
   * ずっと少なくなる（同一シナリオの30日で人口 1216 → 424）。式の上では
   * 1回あたりを1/10にしただけでも、**フィードバックが10倍速く効くぶん実際の成長は落ちる**。
   * 2 にすると 5日440 / 30日1616 / 150日1936 となり、リアルタイム反映を保ったまま
   * 全区間で変更前（392 / 1216 / 1872）を上回る。
   */
  DEMAND_PER_MOVE_IN: 2,
  /**
   * 入居処理を回す間隔（tick）。60tick = 6秒。
   *
   * 日次（600tick）に1回だとまとめて湧くので、区画を塗ってから何も起きない時間が長い
   * （オーナー指摘「需要をリアルタイムで反映して施設が建つと良い」）。
   * **1日あたりの期待棟数は変えない**——1回あたりを `TICKS_PER_DAY / INTERVAL_TICKS` で
   * 割るだけ。成長速度そのものは D7 で調整済みなので動かさない。
   */
  INTERVAL_TICKS: 60,
  /** 抽選の基本重み。M3 で施設バフ growthMul を掛ける口（実装書 §10） */
  BASE_WEIGHT: 1,
} as const;

export const GROWTH = {
  POP_PER_BUILDING: 8,
  SATISFACTION_MIN: 0,
  SATISFACTION_MAX: 100,
  JOBS_PER_COMMERCIAL: 4,
  JOBS_PER_INDUSTRIAL: 6,
  SATISFACTION_START: 50,
  SATISFACTION_TRIP_SUCCESS: 1,
  SATISFACTION_TRIP_FAIL: -4,
  SATISFACTION_OUT_OF_STOCK: -8,
  SATISFACTION_REGRESSION: 1, // 毎日 50 に向かって戻る量
  ABANDON_THRESHOLD: 30,
  ABANDON_DAYS: 3,
  ABANDON_DAYS_WITH_HOSPITAL: 4,
} as const;

export const ECONOMY = {
  START_MONEY: 2000,
  TAX_RESIDENTIAL: 2,
  TAX_COMMERCIAL: 3,
  TAX_INDUSTRIAL: 3,
  COST_ROAD: 10,
  /**
   * 通常道路1タイルを幹線道路へ拡幅する費用。
   * 32タイル1本で4480となり、pop500時点では学校・新エリアとの3択を同時購入できない。
   */
  COST_UPGRADE_ROAD: 140,
  /** 幹線道路を通常道路へ戻す費用。投資額の返金はせず、追加車線の撤去費だけ取る。 */
  COST_DOWNGRADE_ROAD: 2,
  COST_BRIDGE: 50,
  /** 道路タイル自体の撤去費。通常/幹線とも同額で、拡幅費の返金はしない。 */
  COST_DEMOLISH_ROAD: 2,
  COST_CLEAR_FOREST: 5,
  COST_ZONE: 2,
  UPKEEP_ROAD_PER_DAY: 0.05,
  /** 幹線道路は通常道路の5倍。追加容量を維持する高性能な選択肢として扱う。 */
  UPKEEP_ARTERIAL_PER_DAY: 0.25,
  /** 水上の道路に加算する橋梁維持費。通常道路の10倍ぶんを上乗せする。 */
  UPKEEP_BRIDGE_SURCHARGE_PER_DAY: 0.5,
  FACILITY_REFUND_RATIO: 0.25,
  DISTRICT_BASE_PRICE: 1000,
  DISTRICT_PRICE_GROWTH: 1.5,
} as const;

/**
 * 施設（`src/sim/facility/defs.ts`）。**v1 は公園と学校の2種だけ**。
 *
 * 数値の狙いは `docs/m6-plan.md` §2 W5 の通り「人口500の時点で、学校・新エリア・
 * 幹線1本のすべては買えず、どれか1〜2個を選ぶ」こと。**維持費が収入の何%かではなく、
 * 実際の意思決定で調整する。**
 */
export const FACILITY = {
  PARK_COST: 200,
  PARK_UPKEEP: 1,
  PARK_RADIUS: 5,
  /** 半径内の住宅の満足度がこの値を下回らなくなる */
  PARK_SATISFACTION_FLOOR: 45,

  SCHOOL_COST: 500,
  SCHOOL_UPKEEP: 3,
  SCHOOL_RADIUS: 8,
  /**
   * 学校の半径内の住宅が、通常の外出とは**別に**通学の車を出す確率（1tickあたり）。
   *
   * `TRAFFIC.TRIP_RATE_R`（0.01）と同じ桁にしてある。桁を下げると
   * 「置いても何も変わらない」に見え、この施設を入れる意味そのものが消える。
   * **置いた瞬間に流量オーバーレイが変わるのが見えること**が受け入れ基準
   * （`docs/m6-plan.md` §5 死因2）。
   */
  SCHOOL_EXTRA_TRIP_RATE: 0.01,

  /** 撤去時の返金率 */
  REFUND_RATIO: 0.25,
} as const;

/**
 * マイルストーンの報奨金（`src/sim/progress/milestones.ts`）。
 *
 * 日次黒字が貯まり続ける以上、建設費は最終的に待ち時間にしかならない。
 * **大きな資金は蓄積ではなくここから出す**のが設計の意図（`docs/m6-plan.md` §2 W5）。
 */
export const MILESTONE = {
  REWARD_POP100: 500,
  REWARD_POP300: 800,
  REWARD_POP500: 1200,
  REWARD_POP1000: 2000,
  REWARD_POP2000: 3000,
} as const;

export const UI = {
  UNDO_STACK_LIMIT: 50,
  REPORT_HISTORY_DAYS: 30,
} as const;

/**
 * 入力の閾値（`docs/m5-plan.md` §1）。sim の値ではないが、
 * **数値をコードに直書きしない**という規約を入力にも通すためここへ置く。
 * ここを緩めすぎると誤操作が増え、締めすぎると「反応しない」になる。
 */
export const INPUT = {
  /** タップと見なす移動量の上限（px）。指の腹はこれくらい簡単に動く */
  TAP_SLOP_PX: 14,
  /** これを超えて動いたら「線を引きたい」と解釈して建設ドラッグを始める */
  TOOL_SLOP_PX: 6,
  /**
   * 動かないまま押し続けたら「1タイル置きたい」と解釈するまでの時間（ms）。
   *
   * 意図したタップは概ね 80〜200ms かかり、画面を擦っただけの接触はそれより短い。
   * **移動量と時間の両方に閾値を置くのが要点**で、移動だけを見るとタップ建設が死に、
   * 時間だけを見るとドラッグ開始が遅れて線の先頭が欠ける。
   */
  TOOL_HOLD_MS: 90,
  /** 長押し撤去が解除される移動量（px）。タイル座標で見ると倍率で意味が変わる */
  LONG_PRESS_SLOP_PX: 10,
} as const;

/** 分析カテゴリー（`docs/m5-plan.md` §4-3・§4-4） */
export const ANALYSIS = {
  /** 流量EMAの平滑化係数。混雑度より鈍くして「道の実績」に見せる */
  FLOW_ALPHA: 0.02,
  /** 経路オーバーレイを引き直す間隔（tick）。毎フレームは論外 */
  ROUTE_REFRESH_TICKS: 5,
  /** 経路オーバーレイで描く車の上限。超えたぶんは間引く */
  ROUTE_MAX_VEHICLES: 300,
} as const;

export const PICK = {
  VEHICLE_RADIUS_TILES: 0.6,
  MAX_TRACES_PER_BUILDING: 12,
} as const;
