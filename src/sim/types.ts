/**
 * ドメイン型（実装書 §3）。
 * GameState は直列化可能なプレーンオブジェクトに保つ（クラス・関数・Map/Set を含めない）。
 */

export type TileKind = 'plain' | 'water' | 'mountain' | 'forest';
export type ZoneType = 'residential' | 'commercial' | 'industrial';
/** grid.road に保存する道路ランク。0 は道路なし、1 は通常道路、2 は幹線道路。 */
export type RoadRank = 0 | 1 | 2;
/** v2 で 'rail' | 'ship' 等が増える（実装書 §20） */
export type Mode = 'road';
/** 孤立した直交交差点を通る2つの流れ。優先道路の指定単位でもある */
export type IntersectionAxis = 'horizontal' | 'vertical';

/**
 * 交差点信号の保存状態。tick 差だけで経過時間を復元できるプレーンオブジェクトに保つ。
 * allRed の clearingAxis は、青の間に停止線を越えた車だけを排出するために使う。
 */
export type IntersectionSignalState =
  | {
      phase: 'green';
      greenAxis: IntersectionAxis;
      phaseStartedTick: number;
    }
  | {
      phase: 'allRed';
      greenAxis: null;
      clearingAxis: IntersectionAxis;
      nextGreenAxis: IntersectionAxis;
      phaseStartedTick: number;
    };

/** グローバルタイル座標（整数）。チャンク相対座標は使わない */
export interface TilePos {
  x: number;
  y: number;
}

export interface Building {
  id: number;
  pos: TilePos;
  zone: ZoneType;
  /** v1 は常に 1。密度レベル用に予約（実装書 §20） */
  level: 1;
  occupied: boolean;
  satisfaction: number;
  /** commercial のみ: 商品在庫 0..100 */
  stock?: number;
  /** industrial のみ: 生産在庫 0..100 */
  output?: number;
  /** 満足度が閾値を下回った連続日数 */
  lowSatisfactionDays: number;
  /**
   * 今日この建物に着いたトリップ数（満足度 +1 の回数）。
   *
   * インスペクタが「満足度がいま上下している理由」を言葉で出すために要る（実装書 §12.3）。
   * 満足度の増減は traffic と growth の3か所に分散していて、結果の数値だけが残るため、
   * 理由を後から復元できない。**日次でリセットする**（`updateSatisfaction` の末尾）。
   *
   * 増減の内訳そのものを配列で持たせないこと。建物2,000棟ぶんの履歴は
   * セーブ（実装書 §13）とメモリを無駄に膨らませる。在庫切れ・回帰・退去猶予は
   * `stock` / `satisfaction` / `lowSatisfactionDays` から言い当てられる。
   */
  tripsOkToday: number;
  /** 今日この建物で失敗したトリップ数（経路なし + タイムアウト）。日次でリセットする */
  tripsFailToday: number;
}

export interface Facility {
  id: number;
  defId: string;
  /** footprint が 4 のときは左上タイル */
  pos: TilePos;
}

export interface Trip {
  fromBuildingId: number;
  /**
   * 出発元の建物の座標。
   *
   * 描画が「どの建物から出てきたか」を見せるために要る。`fromBuildingId` から
   * 毎フレーム引き直すと、車1,500台ぶんの線形探索（`buildings.find`）が60fps分走るので、
   * spawn 時に座標を控えておく。ダミートリップでは出発元の道路タイルを入れる。
   */
  from: TilePos;
  /** 目的地の建物の座標（道路タイルではない） */
  to: TilePos;
  startedTick: number;
}

/** 車両が脚のどこにいるか。道路経路とは独立した建物アクセスを明示する。 */
export type VehiclePhase = 'exiting' | 'road' | 'entering' | 'dwell';

export interface Vehicle {
  id: number;
  kind: 'car' | 'truck';
  mode: Mode;
  /** 現在走っている脚。往路到着後の滞在中も outbound のまま */
  leg: 'outbound' | 'return';
  /** 現在の脚を出発した tick。滞在時間は含めない */
  legStartedTick: number;
  /** null は走行中、数値なら目的地に滞在して復路の出発を待っている */
  dwellUntilTick: number | null;
  /** 建物から道路、道路上、道路から建物、滞在の明示的な状態 */
  phase: VehiclePhase;
  /** exiting / entering 区間を 0..1 で進んだ割合。道路・滞在中は 0 */
  accessProgress: number;
  /**
   * 建物アクセスの終端で道路への合流を待ち始めた tick。
   *
   * `phase === 'exiting'` かつ `accessProgress === 1` の間だけ設定する。
   * 車両は transient なのでセーブ対象外だが、tick 差で待ち時間を決めることで
   * 同じシード・操作列から同じ合流順を再現できる。
   */
  mergeWaitSinceTick?: number;
  /** 道路タイルだけを含む。建物アクセスの座標を混ぜてはいけない */
  path: TilePos[];
  edgeIndex: number;
  edgeProgress: number;
  /**
   * 最後に動的迂回の A* を試した tick。
   * 車両は transient なのでセーブ対象外。未定義はまだ一度も試していないことを表す。
   */
  lastRerouteTick?: number;
  /** 交差点の停止線で待ち始めた tick。競合時の決定論的な公平制御に使う */
  intersectionWaitSinceTick?: number;
  purpose: Trip;
}

export interface District {
  cx: number;
  cy: number;
  /** 開始チャンク(0,0) のみ false（無償） */
  purchased: boolean;
}

export interface DayReport {
  day: number;
  taxR: number;
  taxC: number;
  taxI: number;
  upkeepRoad: number;
  upkeepFacility: number;
  rewards: number;
  popStart: number;
  popEnd: number;
}

export interface Progress {
  achievedMilestones: string[];
  tutorialDone: boolean;
  lastDayReport: DayReport | null;
  /** 直近 UI.REPORT_HISTORY_DAYS 日。v2 統計グラフの下地（実装書 §20） */
  dayReports: DayReport[];
  /** 累計。統計表示用 */
  totalTrips: number;
  failedTrips: number;
  /**
   * 直近1日ぶんの集計。需要の計算にはこちらを使う。
   *
   * 累計比を使うと、序盤に失敗した分が永久に需要を押し下げ、プレイヤーが道路を
   * 直しても街が二度と回復しない（実測で人口0のまま100日戻らなかった）。
   * 「直したら良くなる」が伝わることがこのゲームの手応えそのものなので、
   * 評価は直近の実績で行う。
   */
  tripsToday: number;
  failedToday: number;
  tripsLastDay: number;
  failedLastDay: number;
  /**
   * 上限（`MAX_ACTIVE_TRIPS_PER_BUILDING`）に阻まれて**出発できなかった**移動の数。
   *
   * **これが無いと、悪い道路網が「見えない形で」需要を消す。**
   * 上限に達した住宅は次の出発抽選そのものを行わないので、
   *   渋滞する → 車の回転が落ちる → 新しい車が出ない → 負荷が自動で下がる
   * という自己安定化が起きる。`tripsToday` は**実際に生成されたトリップしか数えない**ため、
   * 出発できなかったぶんはどの指標にも現れない。結果、人口の頭打ちが
   * 「道路網の限界」ではなく「なぜか成長が止まった」に見えていた（`docs/m6-plan.md` §1-2）。
   *
   * 車は増やさない。**数えるだけ**。上限の背圧（D7）はそのまま維持する。
   */
  unservedToday: number;
  unservedLastDay: number;
}

export interface Grid {
  /** チャンクキー `${cx},${cy}` → タイル配列（CHUNK_SIZE^2） */
  terrain: Record<string, Uint8Array>;
  /** 0=道路なし / 1=通常道路 / 2=幹線道路。base64 セーブ可能な Uint8Array のまま持つ。 */
  road: Record<string, Uint8Array>;
  zone: Record<string, Uint8Array>;
  /** `${x},${y}` → building id */
  buildingIndex: Record<string, number>;
  /** `${x},${y}` → facility id（footprint の全占有タイルを登録） */
  facilityIndex: Record<string, number>;
}

export interface GameState {
  seed: number;
  rngState: number;
  tick: number;
  money: number;
  /** building / facility / vehicle 共通の連番採番カウンタ */
  nextId: number;
  grid: Grid;
  buildings: Building[];
  facilities: Facility[];
  /** transient。セーブに含めない（実装書 §13） */
  vehicles: Vehicle[];
  districts: District[];
  progress: Progress;
  /** 交差点座標 `${x},${y}` → 優先する軸。旧セーブとの互換性のため省略可 */
  intersectionPriorities?: Record<string, IntersectionAxis>;
  /** 無制御交差点の軸別ラウンドロビン履歴。決定論的な再開のためstateに保存する */
  intersectionLastServedAxes?: Record<string, IntersectionAxis>;
  /** 交差点座標 `${x},${y}` → 現示と開始tick。旧セーブとの互換性のため省略可 */
  intersectionSignals?: Record<string, IntersectionSignalState>;
}

/** UI → sim の操作境界（実装書 §12.4） */
export type BuildOp =
  | { kind: 'buildRoad'; tiles: TilePos[] }
  | { kind: 'upgradeRoad'; tiles: TilePos[] }
  | { kind: 'downgradeRoad'; tiles: TilePos[] }
  | { kind: 'demolishRoad'; tiles: TilePos[] }
  | { kind: 'paintZone'; zone: ZoneType; tiles: TilePos[] }
  | { kind: 'eraseZone'; tiles: TilePos[] }
  /**
   * 範囲の一括撤去（道路・区画・建物をまとめて消す）。撤去ツールの矩形ドラッグで使う。
   *
   * `demolishRoad` + `eraseZone` を2回 applyOp するのではなく1つの op にするのは、
   * Undo の単位を「プレイヤーの1操作」と一致させるため（実装書 §2.2）。
   */
  | { kind: 'demolishArea'; tiles: TilePos[] }
  | { kind: 'placeFacility'; defId: string; pos: TilePos }
  | { kind: 'removeFacility'; id: number }
  | { kind: 'buyDistrict'; cx: number; cy: number }
  /** axis=null は優先指定を外して無制御へ戻す */
  | { kind: 'setIntersectionPriority'; pos: TilePos; axis: IntersectionAxis | null };

export type OpResult = { ok: true } | { ok: false; reason: string };

export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
