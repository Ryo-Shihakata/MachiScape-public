/**
 * ゲーム画面の描画（実装書 §17 の性能予算に沿う）。
 *
 * 描き分けの方針:
 * - 地形はチャンク単位で一度だけ描く（変化しないので毎フレーム描き直さない）
 * - 道路・区画・建物は変化したときだけ描き直す（dirty フラグ）
 * - 車だけ毎フレーム描き直す
 *
 * カメラ変換はワールドコンテナにまとめて掛ける。こうすると中身は
 * ワールド座標（タイル単位）のまま描けて、パン/ズームで再描画が要らない。
 */

import { Application, BlurFilter, Container, Graphics } from 'pixi.js';
import { GROWTH, PICK, SPACE, TRAFFIC } from '../sim/balance';
import { facilityDef, type FacilityDef } from '../sim/facility/defs';
import { buildingIdAt, facilityIdAt, hasRoad, roadRankAt, terrainAt, zoneAt } from '../sim/grid';
import { isUnlocked } from '../sim/progress/milestones';
import type {
  GameState,
  IntersectionAxis,
  RoadRank,
  TilePos,
  VehiclePhase,
  ZoneType,
} from '../sim/types';
import {
  intersectionAxisCanEnter,
  intersectionStopDistanceFromCenter,
  logicalLaneIndex,
  traceVehicle,
  tracesForBuilding,
  type IntersectionSignalView,
  type TripTrace,
  type VehicleView,
} from '../sim/traffic';
import type { CongestionMap } from '../sim/road/congestion';
import { diagonalAllowed } from '../sim/road/connectivity';
import type { FlowMap } from '../sim/road/flow';
import type { IntersectionDirections } from '../sim/road/intersection';
import { districtPrice } from '../sim/world';
import type { World } from '../sim/world';
import type { Camera } from './camera';
import { tileScreenSize, worldToScreen } from './camera';
import type { Theme } from './theme';

const CS = SPACE.CHUNK_SIZE;
const ROAD_W = 0.5;
/** 4車線相当（片方向2レーン）の幹線。通常道路との差を低ズームでも読める幅にする。 */
const ARTERIAL_ROAD_W = 0.82;
const CAR_LENGTH = 0.3;
const CAR_WIDTH = 0.15;
const TRUCK_LENGTH = 0.44;
const TRUCK_WIDTH = 0.19;
const CAR_RADIUS = 0.05;
const CAR_CABIN_LENGTH = 0.12;
const CAR_CABIN_WIDTH = 0.1;
const CAR_CABIN_RADIUS = 0.03;
const CAR_CABIN_OFFSET = -0.02;
const TRUCK_CAB_LENGTH = 0.14;
const TRUCK_CAB_WIDTH = 0.17;
const TRUCK_CAB_RADIUS = 0.04;
const TRUCK_CAB_OFFSET = 0.15;
const TRUCK_BED_LENGTH = 0.28;
const TRUCK_BED_WIDTH = 0.19;
const TRUCK_BED_RADIUS = 0.03;
const TRUCK_BED_OFFSET = -0.08;
const BRAKE_DIAMETER = 0.05;
const BRAKE_MIN_ALPHA = 0.3;
const BRAKE_SPEED_RATIO_THRESHOLD = 0.9;
/** タブ復帰など、この長さを超えたフレームでは移動量を比較しない */
const MAX_BRAKE_FRAME_SECONDS = 0.25;
/** 消えた車の位置履歴を低頻度で掃除する間隔。毎フレーム delete しない */
const BRAKE_HISTORY_CLEANUP_FRAMES = 600;

/** 経路表示の寸法。ゲーム進行には影響しないため、道路幅と同じく描画側で持つ。 */
const TRACE_VIS = {
  SELECTED_PAST_WIDTH: 0.09,
  SELECTED_FUTURE_WIDTH: 0.17,
  BUILDING_PAST_WIDTH: 0.035,
  BUILDING_FUTURE_WIDTH: 0.065,
  PAST_ALPHA: 0.58,
  FUTURE_ALPHA: 0.92,
  ORIGIN_RING_RADIUS: 0.4,
  ORIGIN_RING_WIDTH: 0.07,
  DEST_RING_RADIUS: 0.34,
  DEST_RING_WIDTH: 0.08,
  DEST_FILL_ALPHA: 0.16,
  DEST_PULSE_RADIUS: 0.09,
  DEST_PULSE_PERIOD_MS: 1800,
} as const;

/**
 * 車線（左側通行）の表現。GPT-5レビューで確定した方針: sim には車線を持たせず、
 * 描画だけで進行方向の法線へ車の中心をずらす。0.10〜0.12タイルの指定域の中で
 * 0.11を採用。ズーム0.25では車線差が 32px(タイル) × 0.11 × 2 × 0.25 ≒ 1.76px しか
 * 出ず判別できないが、それは仕様どおり（低ズームでの車線表現は諦めてよい）。
 */
const LANE_OFFSET = 0.11;
/** 幹線では片方向2レーンを内外に描き分ける。外側でも車体が道路幅に収まる値。 */
const ARTERIAL_LANE_INNER_OFFSET = 0.14;
const ARTERIAL_LANE_OUTER_OFFSET = 0.3;

/** 描画テストと道路描画が共有する道路幅。見た目の定数はこのファイルだけに置く。 */
export function roadRenderWidth(rank: RoadRank): number {
  return rank === 2 ? ARTERIAL_ROAD_W : ROAD_W;
}

/** sim と同じ id 偶奇の論理レーンを、幹線の内外オフセットへ写す。 */
export function vehicleLaneOffset(vehicleId: number, rank: RoadRank): number {
  if (rank !== 2) return LANE_OFFSET;
  return logicalLaneIndex(vehicleId, rank) === 0
    ? ARTERIAL_LANE_INNER_OFFSET
    : ARTERIAL_LANE_OUTER_OFFSET;
}

/**
 * 交差点マーカーの見た目（`docs/m4-ui-design.md` §1.3）。
 * ゲームバランスではないので `balance.ts` には置かない。
 */
const MARKER = {
  /** 道路（幅0.5）より少し大きく、囲んでいることが分かる大きさ */
  RING_RADIUS: 0.4,
  RING_WIDTH: 0.05,
  RING_ALPHA: 0.5,
  BAND_LENGTH: 0.9,
  BAND_THICKNESS: 0.14,
  BAND_OUTLINE_WIDTH: 0.035,
  BAND_ALPHA: 0.85,
  /**
   * 停止線を置く距離（交差点タイルの中心から）。
   * **sim が実際に止める位置から導出する**（`intersectionStopDistanceFromCenter`）。
   * ここに独自の数値を書くと、赤い線と実際の停止位置がずれる
   * （実際に半タイル以上ずれていて、オーナーから指摘を受けた）。
   */
  STOP_DISTANCE: intersectionStopDistanceFromCenter(),
  STOP_LENGTH: 0.34,
  STOP_THICKNESS: 0.08,
  STOP_ALPHA: 0.8,
} as const;
/**
 * 交差点タイル（接続数3以上）の中心での最小オフセット。0にはしない
 * （0にすると交差点の瞬間だけ車がセンターラインに乗って見えて不自然）。
 */
const LANE_OFFSET_AT_INTERSECTION = 0.03;
/** 交差点タイルの中心からこの距離（タイル単位）離れたら通常のオフセットに戻す */
const INTERSECTION_DAMPEN_RADIUS = 0.15;

/** 交差点判定に使う斜め4方向（`NEIGHBORS`とは別に持つ。こちらはモジュール直下の純関数用） */
const DIAGONAL_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * タイル (x, y) の道路としての接続数（車線オフセットの交差点弱めに使う）。
 *
 * **生の8近傍で数えてはいけない。** `paintRoadLike` の説明にもあるとおり、十字路では
 * 四方の腕どうしが互いに斜め隣接している。生の8近傍で数えると、本来4接続の十字路が
 * 8接続に見えてしまい、直交だけの交差点まで判定を誤る。経路探索・道路描画と同じ
 * `diagonalAllowed` の規則で、斜めは「両方の直交隣接が道路でない」ときだけ数える。
 */
function countRoadConnections(
  has: (x: number, y: number) => boolean,
  x: number,
  y: number,
): number {
  let n = 0;
  if (has(x, y - 1)) n++;
  if (has(x, y + 1)) n++;
  if (has(x - 1, y)) n++;
  if (has(x + 1, y)) n++;
  for (const [dx, dy] of DIAGONAL_DIRS) {
    if (has(x + dx, y + dy) && diagonalAllowed(has, x, y, dx, dy)) n++;
  }
  return n;
}

/**
 * 交差点（接続数3以上のタイル）に近いほど車線オフセットを弱める。
 *
 * `x, y` は（建物への出入りブレンド前の）道路上の実位置を渡すこと。出入り中の
 * 見た目の位置は建物中心へ寄っていくため、それで交差点判定すると道路上の
 * 位置とズレる。タイル中心は必ず整数+0.5なので、最寄りのタイルは丸めで求まる。
 */
function intersectionOffsetMagnitude(
  x: number,
  y: number,
  laneOffset: number,
  isIntersection: (x: number, y: number) => boolean,
): number {
  const tx = Math.round(x - 0.5);
  const ty = Math.round(y - 0.5);
  if (!isIntersection(tx, ty)) return laneOffset;
  const dist = Math.hypot(x - (tx + 0.5), y - (ty + 0.5));
  if (dist >= INTERSECTION_DAMPEN_RADIUS) return laneOffset;
  const t = dist / INTERSECTION_DAMPEN_RADIUS;
  return LANE_OFFSET_AT_INTERSECTION + (laneOffset - LANE_OFFSET_AT_INTERSECTION) * t;
}

/** 車1台ぶんの描画結果（回帰テスト用に純関数として切り出す） */
export interface CarRenderState {
  x: number;
  y: number;
  angle: number;
  /** 車はフェードさせず、建物レイヤの遮蔽で隠すため常に1 */
  opacity: number;
}

/**
 * 車1台の描画位置・向き・不透明度を求める純関数。
 *
 * 建物アクセスの位置・向きは sim の `VehicleView` が既に実距離と ACCESS_SPEED から
 * 求めている。描画側は独自の時計や道路辺の一部を使って補間しない。
 * 車体は常に一定サイズ・完全不透明で、建物の下を通ることで自然に隠れる。
 *
 * **車線オフセット（左側通行）**: 道路の進行方向の左法線へ、`x, y` を
 * `intersectionOffsetMagnitude` ぶんだけずらす。アクセス中だけ `accessRoadAngle` を使い、
 * 私道と道路の境界で車線位置が跳ばないようにする。車体の向きは実際に動く方向なので、
 * `cos/sin` は常に単位ベクトルになり、斜めの辺でもオフセット量は変わらない
 * （正規化の担保）。曲がり角の対処もこれで賄える——`VehicleView.angle` は
 * `game/loop.ts` の tick境界補間（フィレット/2次ベジェ）が生成する接線方向であり、
 * 辺ごとの生の角度ではなく既に角を丸めた進行方向になっているため、法線が
 * 横方向に跳ばない。
 *
 * 建物アクセス中は、建物中心で車線オフセットを0にし、道路へ近づくにつれて通常値へ
 * 滑らかに戻す。道路上の左側通行と交差点での弱めは従来どおり維持する。
 *
 * 交差点の弱めは、建物ブレンド前の道路上の実位置（`v.x, v.y`）で判定する
 * （`isIntersection` 省略時は常に false＝弱めない。ユニットテストからは、
 * 実際のPixiシーンを介さず任意の交差点判定を注入できる）。
 *
 * 走行中（出入り区間でない）は `VehicleView` の座標・向きに車線オフセットを足した
 * ものを返す（`opacity: 1`）。オフセットを除けば元の座標に一致することをテストで
 * 保証する。
 */
export function carRenderState(
  v: VehicleView,
  isIntersection: (x: number, y: number) => boolean = () => false,
): CarRenderState {
  const phase = v.phase ?? 'road';
  const progress = v.phaseProgress ?? v.edgeProgress;
  const laneFactor = phase === 'exiting' ? progress : phase === 'entering' ? 1 - progress : 1;
  const laneOffset = vehicleLaneOffset(v.id, v.roadRank ?? 1);
  const magnitude = laneFactor * intersectionOffsetMagnitude(v.x, v.y, laneOffset, isIntersection);
  const angle = v.angle;
  const laneAngle = phase === 'road' ? angle : (v.accessRoadAngle ?? angle);
  // 左側通行: 進行方向 (cos, sin) を向いたときの左手側 = (sin, -cos)。
  // 座標系は y が下向き（タイル座標）なので、東向き(angle=0)の左手（北）は -y になる。
  return {
    x: v.x + Math.sin(laneAngle) * magnitude,
    y: v.y - Math.cos(laneAngle) * magnitude,
    angle,
    opacity: 1,
  };
}

/**
 * 最後に描いた VehicleView から、タップ点に最も近い車を決定論的に拾う。
 * sim 座標ではなく `carRenderState` 後の車線オフセット込み座標を使わないと、
 * 見えている車と当たり判定がずれてスマホで選べなくなる。
 */
export function pickVehicleAt(
  views: readonly VehicleView[],
  point: { x: number; y: number },
  isIntersection: (x: number, y: number) => boolean = () => false,
): number | null {
  const radiusSq = PICK.VEHICLE_RADIUS_TILES * PICK.VEHICLE_RADIUS_TILES;
  let bestId: number | null = null;
  let bestDistanceSq = Infinity;
  for (const view of views) {
    const rendered = carRenderState(view, isIntersection);
    const dx = rendered.x - point.x;
    const dy = rendered.y - point.y;
    const distanceSq = dx * dx + dy * dy;
    if (
      distanceSq <= radiusSq &&
      (distanceSq < bestDistanceSq ||
        (distanceSq === bestDistanceSq && (bestId === null || view.id < bestId)))
    ) {
      bestId = view.id;
      bestDistanceSq = distanceSq;
    }
  }
  return bestId;
}

/**
 * 車種ごとの大きさ。**状況（走行中／出入り中）に一切依存しない**——サイズを常に
 * 一定にするという要件そのものを型で表す（引数が `kind` だけなので変えようがない）。
 * 自家用車とトラックのサイズ差は維持する。
 */
export function carDimensions(kind: VehicleView['kind']): { length: number; width: number } {
  return kind === 'truck'
    ? { length: TRUCK_LENGTH, width: TRUCK_WIDTH }
    : { length: CAR_LENGTH, width: CAR_WIDTH };
}

/**
 * 実移動量と最高速での期待移動量から、ブレーキの強さ（0〜1）を返す純関数。
 *
 * 描画補間や浮動小数点の揺れで微小なランプが常時点灯しないよう、期待速度の90%以上は
 * 通常走行として扱う。それより遅い範囲を0〜1へ正規化するので、停止時は必ず1になる。
 */
export function brakeIntensity(distanceMoved: number, expectedDistance: number): number {
  if (
    !Number.isFinite(distanceMoved) ||
    !Number.isFinite(expectedDistance) ||
    expectedDistance <= 0
  ) {
    return 0;
  }
  const speedRatio = Math.max(0, distanceMoved) / expectedDistance;
  if (speedRatio >= BRAKE_SPEED_RATIO_THRESHOLD) return 0;
  return Math.min(1, (BRAKE_SPEED_RATIO_THRESHOLD - speedRatio) / BRAKE_SPEED_RATIO_THRESHOLD);
}

/** 24bit RGBを別の色へ`amount`だけ寄せる（車の部品色専用。themeトークンは増やさない） */
function mixColor(from: number, to: number, amount: number): number {
  const r = Math.round(((from >> 16) & 0xff) * (1 - amount) + ((to >> 16) & 0xff) * amount);
  const g = Math.round(((from >> 8) & 0xff) * (1 - amount) + ((to >> 8) & 0xff) * amount);
  const b = Math.round((from & 0xff) * (1 - amount) + (to & 0xff) * amount);
  return (r << 16) | (g << 8) | b;
}

/**
 * 中心・向き・寸法から回転済みの角丸長方形パスを積む。
 *
 * `Graphics#roundRect` と同じ角丸矩形を4本の二次曲線で作り、各点だけを`angle`由来の
 * 単位ベクトルで変換する。Graphics/Container/Matrixを車ごとに生成・回転しないため、
 * 毎フレーム最大1,500台でもパスを同色ごとにまとめてfillできる。
 */
function appendRotatedRoundRect(
  g: Graphics,
  cx: number,
  cy: number,
  cos: number,
  sin: number,
  length: number,
  width: number,
  radius: number,
): void {
  const hl = length / 2;
  const hw = width / 2;
  const r = Math.min(radius, hl, hw);
  // ループ内で呼ばれるため、座標変換用のクロージャやPointも生成せず数値のまま渡す。
  g.moveTo(cx + (-hl + r) * cos + hw * sin, cy + (-hl + r) * sin - hw * cos)
    .lineTo(cx + (hl - r) * cos + hw * sin, cy + (hl - r) * sin - hw * cos)
    .quadraticCurveTo(
      cx + hl * cos + hw * sin,
      cy + hl * sin - hw * cos,
      cx + hl * cos + (hw - r) * sin,
      cy + hl * sin - (hw - r) * cos,
    )
    .lineTo(cx + hl * cos - (hw - r) * sin, cy + hl * sin + (hw - r) * cos)
    .quadraticCurveTo(
      cx + hl * cos - hw * sin,
      cy + hl * sin + hw * cos,
      cx + (hl - r) * cos - hw * sin,
      cy + (hl - r) * sin + hw * cos,
    )
    .lineTo(cx + (-hl + r) * cos - hw * sin, cy + (-hl + r) * sin + hw * cos)
    .quadraticCurveTo(
      cx - hl * cos - hw * sin,
      cy - hl * sin + hw * cos,
      cx - hl * cos - (hw - r) * sin,
      cy - hl * sin + (hw - r) * cos,
    )
    .lineTo(cx - hl * cos + (hw - r) * sin, cy - hl * sin - (hw - r) * cos)
    .quadraticCurveTo(
      cx - hl * cos + hw * sin,
      cy - hl * sin - hw * cos,
      cx + (-hl + r) * cos + hw * sin,
      cy + (-hl + r) * sin - hw * cos,
    )
    .closePath();
}

export interface PreviewTile {
  x: number;
  y: number;
  valid: boolean;
}

/**
 * 交差点マーカー1件ぶん（`docs/m4-ui-design.md` §1.3）。
 *
 * UI 側は sim の状態（`orthogonalIntersectionAt` と `state.intersectionPriorities`）から
 * この配列を作って渡すだけでよい。**描画の中身はここが持つ**ので、
 * UI 担当は `gameScene.ts` を触らずに済む。
 */
export interface IntersectionMarker {
  pos: TilePos;
  /** プレイヤー設定の優先軸。null は未設定。黄色い中空帯で現示と区別する。 */
  axis: IntersectionAxis | null;
  /** sim が通行判定にも使う現在現示。青／赤の唯一の入力。 */
  signal: IntersectionSignalView;
  /** 「交通」ツール選択中か（対象を光らせるかどうか） */
  highlighted: boolean;
  /**
   * 直交4方向のうち道路がある向き（`orthogonalIntersectionAt` が返す `directions`）。
   * 停止線をこの向きにだけ描く（M5 §4-1: T字路で道路の無い側にも停止線が浮いていたバグの修正）。
   */
  directions: IntersectionDirections;
}

/**
 * 停止線を描く（軸・符号）の一覧を、道路がある向きだけに絞る（M5 §4-1）。
 *
 * 純関数として切り出すのは、Pixi の描画呼び出しを介さずにテストするため
 * （`gameScene.test.ts` の「T字路では3方向にだけ」テスト）。
 * 符号の向きは `drawIntersectionMarkers` の座標計算と対応させる:
 * horizontal・sign=+1 は東（east）、-1 は西（west）。vertical・sign=+1 は南（south、
 * タイル座標は下向きが正）、-1 は北（north）。
 */
export function intersectionStopLineDirections(
  directions: IntersectionDirections,
): Array<{ axis: IntersectionAxis; sign: 1 | -1 }> {
  const out: Array<{ axis: IntersectionAxis; sign: 1 | -1 }> = [];
  if (directions.east) out.push({ axis: 'horizontal', sign: 1 });
  if (directions.west) out.push({ axis: 'horizontal', sign: -1 });
  if (directions.south) out.push({ axis: 'vertical', sign: 1 });
  if (directions.north) out.push({ axis: 'vertical', sign: -1 });
  return out;
}

// ---------------------------------------------------------------------------
// M6 W1: エリア購入（`docs/m6-plan.md` §2 W1）
// ---------------------------------------------------------------------------

/**
 * 解放済みチャンクに隣接する未購入チャンクを列挙する（実装書 §11「エリア購入」）。
 *
 * `game/loop.ts`（タップ判定）と `redrawWorld`（買える土地の薄い着色）の両方が
 * 同じ集合を必要とするので、ここに1本化する。`districts` はプレイヤーが実際に
 * 持っているチャンク（開始チャンクを含む）の配列で、その4近傍のうちまだ
 * 持っていないものが「買える土地」になる。
 *
 * 1チャンクにつき隣接候補が重複しうる（正方形が隣り合って共有する隣）ので、
 * 見た目・購入判定のどちらでも二重に数えないよう `seen` で剪定する。
 */
export function listBuyableChunks(
  districts: readonly { cx: number; cy: number }[],
): Array<{ cx: number; cy: number }> {
  const owned = new Set(districts.map((d) => `${d.cx},${d.cy}`));
  const seen = new Set<string>();
  const out: Array<{ cx: number; cy: number }> = [];
  for (const d of districts) {
    for (const [dx, dy] of NEIGHBOR_CHUNK_OFFSETS) {
      const cx = d.cx + dx;
      const cy = d.cy + dy;
      const key = `${cx},${cy}`;
      if (owned.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ cx, cy });
    }
  }
  return out;
}

const NEIGHBOR_CHUNK_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// ---------------------------------------------------------------------------
// M6 W4: 施設ツール（`docs/m6-plan.md` §2 W4）
// ---------------------------------------------------------------------------

/** 施設の占有タイル。footprint=4 は pos を左上として2x2（`sim/facility/defs.ts` の規約） */
export function facilityFootprintTiles(pos: TilePos, footprint: 1 | 4): TilePos[] {
  if (footprint === 1) return [{ x: pos.x, y: pos.y }];
  return [
    { x: pos.x, y: pos.y },
    { x: pos.x + 1, y: pos.y },
    { x: pos.x, y: pos.y + 1 },
    { x: pos.x + 1, y: pos.y + 1 },
  ];
}

/**
 * 効果範囲（チェビシェフ距離＝正方形。`FacilityDef.radius` の規約）のタイル境界。
 * footprint 全体からの距離として、外周を `radius` ぶん広げた矩形を返す（両端含む）。
 */
export function facilityRadiusBounds(
  pos: TilePos,
  footprint: 1 | 4,
  radius: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const size = footprint === 4 ? 2 : 1;
  return {
    x0: pos.x - radius,
    y0: pos.y - radius,
    x1: pos.x + size - 1 + radius,
    y1: pos.y + size - 1 + radius,
  };
}

/**
 * 設置プレビューの可否（`docs/m6-plan.md` §2 W4「設置プレビュー」）。
 *
 * **sim 側の `placeFacility` はまだ未実装で、`canApplyOp` は常に失敗を返す**
 * （別の作業者が並行実装中。`src/sim/world.ts` は触らない）。そのため確定の可否は
 * 最終的に `applyOp` の結果（トースト）に委ねるしかないが、置く前に色で示す
 * ヒントは要るので、ここでは読み取り専用の sim 関数だけを使ってベストエフォートの
 * 判定をする: 地形（平地・森のみ）・道路や区画や既存の建物/施設との重なり・
 * 解放状況・資金。**この判定は本番の許可判定と完全には一致しない**——sim 側の
 * 実装が入ったら `canApplyOp` に寄せて置き換えること。
 */
export function facilityPlacementValid(state: GameState, def: FacilityDef, pos: TilePos): boolean {
  const unlocked = def.unlock === 'start' || isUnlocked(state.progress.achievedMilestones, def.id);
  if (!unlocked) return false;
  if (state.money < def.cost) return false;
  const tiles = facilityFootprintTiles(pos, def.footprint);
  return tiles.every((t) => {
    const terrain = terrainAt(state.grid, t.x, t.y);
    if (terrain === undefined || terrain === 'water' || terrain === 'mountain') return false;
    if (hasRoad(state.grid, t.x, t.y)) return false;
    if (zoneAt(state.grid, t.x, t.y) !== null) return false;
    if (buildingIdAt(state.grid, t.x, t.y) !== undefined) return false;
    if (facilityIdAt(state.grid, t.x, t.y) !== undefined) return false;
    return true;
  });
}

/** 施設の設置プレビュー（footprint の色＋効果範囲の枠）。`game/loop.ts` が組み立てて渡す */
export interface FacilityPreview {
  footprint: PreviewTile[];
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * 情報オーバーレイの描画に渡す文脈。
 *
 * **`GameState` 単体にしないこと。** 渋滞ヒートマップの元データ `congestionEMA` は
 * `GameState` ではなく `World.congestion` に載っているため、state だけ渡すと
 * 渋滞オーバーレイが描けない。流量（`flow`）も同じ理由で別枠——`World` には持たせず
 * `game/loop.ts` が保持する `FlowMap` をここへ渡す（M5 §4-3。`World` 型を増やすと
 * sim 側の担当ファイルに手を入れることになるため、描画専用のデータとして外に置く）。
 */
export interface OverlayContext {
  state: GameState;
  congestion: CongestionMap;
  flow: FlowMap;
  theme: Theme;
}

/**
 * オーバーレイの描画関数。`overlayLayer` は呼び出し側が毎回 clear してから渡す。
 * ワールド座標（タイル単位）でそのまま描いてよい（カメラ変換は親コンテナが持つ）。
 */
export type OverlayDraw = (g: Graphics, ctx: OverlayContext) => void;

export interface GameScene {
  app: Application;
  /** 地形・道路・区画・建物を描き直す。建設操作のあとに呼ぶ */
  markDirty(): void;
  /** ドラッグ中の建設プレビュー（空配列で消去） */
  setPreview(tiles: PreviewTile[]): void;
  /**
   * 施設ツールの設置プレビュー（footprint の色＋効果範囲の枠。`docs/m6-plan.md` §2 W4）。
   * `setPreview` とは別枠にする——道路・区画と違い「面」ではなく1〜4タイルの
   * footprint と、それを取り囲む効果範囲の正方形という異なる形を描くため。
   * null で消去。
   */
  setFacilityPreview(preview: FacilityPreview | null): void;
  /**
   * 情報オーバーレイの描画関数を差し替える（null で消灯＝既定）。
   * 同時に有効なのは1つだけ（実装書 §12.3）。
   */
  setOverlay(draw: OverlayDraw | null): void;
  /**
   * 交差点マーカーを差し替える（`docs/m4-ui-design.md` §1.3）。
   * 現示が変わるsim tickと建設・優先設定の変更時に呼ぶ。毎描画フレームでは呼ばないこと
   */
  setIntersectionMarkers(markers: readonly IntersectionMarker[]): void;
  /** 最後の描画フレームに見えていた車を、描画位置で拾う */
  pickVehicle(point: { x: number; y: number }): number | null;
  /** 車1台または建物に紐づく経路を表示する。null で消す */
  setTraceSelection(selection: TraceSelection | null): void;
  /**
   * 毎フレーム呼ぶ。`flow` は流量オーバーレイ（M5 §4-3）用で、`World` には持たせていない
   * ため呼び出し側（`game/loop.ts`）から都度渡す（`OverlayContext` のコメント参照）。
   */
  render(world: World, vehicles: VehicleView[], cam: Camera, flow: FlowMap): void;
  destroy(): void;
}

export type TraceSelection =
  | {
      kind: 'vehicle';
      vehicleId: number;
      /** UI 側で Esc・閉じる・ツール切替が起きたことを逆依存なしで検知する */
      isCurrent: () => boolean;
      /** 車が sim から消えたフレームで UI の選択も閉じる */
      onMissing: () => void;
    }
  | {
      kind: 'building';
      buildingId: number;
      isCurrent: () => boolean;
    };

function zoneColor(theme: Theme, z: ZoneType): number {
  return z === 'residential'
    ? theme.residential
    : z === 'commercial'
      ? theme.commercial
      : theme.industrial;
}

export async function createGameScene(host: HTMLElement, theme: Theme): Promise<GameScene> {
  const app = new Application();
  await app.init({
    resizeTo: host,
    background: theme.background,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  host.appendChild(app.canvas);
  app.canvas.style.display = 'block';

  // テーマはシーンの生存中変わらないため、部品色も毎フレーム再計算しない。
  const carCabinColor = mixColor(theme.vehicleCar, 0xffffff, 0.35);
  const truckBedColor = mixColor(theme.vehicleTruck, 0x000000, 0.15);

  const world = new Container();
  app.stage.addChild(world);

  const terrainLayer = new Graphics();
  const gridLineLayer = new Graphics();
  // 買える土地（M6 W1）。地形の代わりに塗るものなので terrain/grid の直後、
  // 区画・道路より下に置く（買える土地には元々どちらも存在しない）。
  const districtBuyableLayer = new Graphics();
  const zoneLayer = new Graphics();
  const roadShadowLayer = new Graphics();
  const roadLayer = new Graphics();
  const traceStaticLayer = new Graphics();
  const traceDynamicLayer = new Graphics();
  const carShadowLayer = new Graphics();
  const carLayer = new Graphics();
  const buildingShadowLayer = new Graphics();
  const buildingLayer = new Graphics();
  // 施設（M6 W4）。建物と同じ「地物」として建物の直後に置く（車の下・交差点マーカーの下）
  const facilityLayer = new Graphics();
  // 交差点マーカーは建物より上・情報オーバーレイより下。
  // 道路や建物に隠れてはいけないが、渋滞ヒートマップ等を隠してもいけない
  const intersectionLayer = new Graphics();
  // オーバーレイは道路・建物より「上」に置く。渋滞ヒートマップは道路タイルの混雑度を
  // 塗るものなので、道路より下に置くと道路の色に隠れて何も見えない
  const overlayLayer = new Graphics();
  const previewLayer = new Graphics();

  roadShadowLayer.filters = [new BlurFilter({ strength: 3, quality: 2 })];
  buildingShadowLayer.filters = [new BlurFilter({ strength: 2, quality: 2 })];
  carShadowLayer.filters = [new BlurFilter({ strength: 2, quality: 2 })];

  world.addChild(
    terrainLayer,
    gridLineLayer,
    districtBuyableLayer,
    zoneLayer,
    roadShadowLayer,
    roadLayer,
    // 経路は道路を覆って読める一方、車体を隠さない位置に固定する。
    traceStaticLayer,
    traceDynamicLayer,
    // 私道を走る車は建物の下へ入り、フェードなしで屋根に隠れる。
    // 交差点・情報オーバーレイ・建設プレビューはこの後ろに置き、常に車より上に保つ。
    carShadowLayer,
    carLayer,
    buildingShadowLayer,
    buildingLayer,
    facilityLayer,
    intersectionLayer,
    overlayLayer,
    previewLayer,
  );

  let dirty = true;
  let intersectionDirty = true;
  let preview: PreviewTile[] = [];
  /** 施設ツールの設置プレビュー。null は非表示（`setPreview` と別枠で持つ理由は型定義を参照） */
  let facilityPreview: FacilityPreview | null = null;
  let intersectionMarkers: readonly IntersectionMarker[] = [];
  let overlayDraw: OverlayDraw | null = null;
  let traceSelection: TraceSelection | null = null;
  let lastTraceTick = -1;
  let lastTraceSignature = '';
  let lastRenderedVehicles: readonly VehicleView[] = [];

  interface RenderTrace {
    trace: TripTrace;
    phase: VehiclePhase;
  }

  let renderTraces: RenderTrace[] = [];
  /**
   * 交差点タイル（接続数3以上）の集合。`x -> その x 列にある交差点の y の集合`。
   *
   * `drawCars` は毎フレーム・最大1,500台ぶん呼ばれるので、ここは文字列キーの
   * `Set<string>`（`` `${x},${y}` ``）ではなく `Map<number, Set<number>>` にする。
   * 数値キーなら毎フレームの文字列生成が要らない。道路の再描画（`redrawWorld`）
   * でだけ作り直し、車の描画では参照するだけにする（毎フレーム数え直さない）。
   */
  let intersectionsByX = new Map<number, Set<number>>();

  interface PreviousCarPosition {
    x: number;
    y: number;
    lastSeenFrame: number;
  }

  /** ブレーキ判定用。Mapと値オブジェクトはフレーム間で使い回す */
  const previousCarPositions = new Map<number, PreviousCarPosition>();
  let previousCarFrameMs: number | null = null;
  let carFrame = 0;

  // 複数の描画パスで同じ計算結果を使うための再利用バッファ。台数増加時だけ拡張する。
  let renderX = new Float64Array(0);
  let renderY = new Float64Array(0);
  let renderCos = new Float64Array(0);
  let renderSin = new Float64Array(0);
  let renderBrake = new Float64Array(0);

  function ensureCarRenderCapacity(size: number): void {
    if (renderX.length >= size) return;
    const capacity = Math.max(size, renderX.length * 2, 16);
    renderX = new Float64Array(capacity);
    renderY = new Float64Array(capacity);
    renderCos = new Float64Array(capacity);
    renderSin = new Float64Array(capacity);
    renderBrake = new Float64Array(capacity);
  }

  function isIntersectionTile(x: number, y: number): boolean {
    return intersectionsByX.get(x)?.has(y) ?? false;
  }

  function clearTraces(): void {
    traceStaticLayer.clear();
    traceDynamicLayer.clear();
    renderTraces = [];
    lastTraceSignature = '';
    lastTraceTick = -1;
  }

  function strokeTracePath(
    path: readonly TilePos[],
    from: number,
    to: number,
    width: number,
    color: number,
    alpha: number,
  ): void {
    if (from < 0 || to >= path.length || from >= to) return;
    const first = path[from];
    if (!first) return;
    traceStaticLayer.moveTo(first.x + 0.5, first.y + 0.5);
    for (let i = from + 1; i <= to; i++) {
      const point = path[i];
      if (!point) return;
      traceStaticLayer.lineTo(point.x + 0.5, point.y + 0.5);
    }
    traceStaticLayer.stroke({ width, color, alpha, cap: 'round', join: 'round' });
  }

  function traceSignature(traces: readonly RenderTrace[]): string {
    let signature = '';
    for (const { trace, phase } of traces) {
      signature += `${trace.vehicleId}:${trace.leg}:${phase}:${trace.edgeIndex}:`;
      for (const point of trace.path) signature += `${point.x},${point.y}/`;
      signature += ';';
    }
    return signature;
  }

  function drawStaticTraces(): void {
    traceStaticLayer.clear();
    const selectedVehicle = traceSelection?.kind === 'vehicle';
    const pastWidth = selectedVehicle
      ? TRACE_VIS.SELECTED_PAST_WIDTH
      : TRACE_VIS.BUILDING_PAST_WIDTH;
    const futureWidth = selectedVehicle
      ? TRACE_VIS.SELECTED_FUTURE_WIDTH
      : TRACE_VIS.BUILDING_FUTURE_WIDTH;

    for (const { trace, phase } of renderTraces) {
      const last = trace.path.length - 1;
      if (phase === 'exiting') {
        strokeTracePath(
          trace.path,
          0,
          last,
          futureWidth,
          theme.traceFuture,
          TRACE_VIS.FUTURE_ALPHA,
        );
      } else if (phase === 'road') {
        strokeTracePath(
          trace.path,
          0,
          Math.min(last, trace.edgeIndex),
          pastWidth,
          theme.tracePast,
          TRACE_VIS.PAST_ALPHA,
        );
        strokeTracePath(
          trace.path,
          Math.min(last, trace.edgeIndex + 1),
          last,
          futureWidth,
          theme.traceFuture,
          TRACE_VIS.FUTURE_ALPHA,
        );
      } else {
        strokeTracePath(trace.path, 0, last, pastWidth, theme.tracePast, TRACE_VIS.PAST_ALPHA);
      }
    }

    if (selectedVehicle && renderTraces[0]) {
      const trace = renderTraces[0].trace;
      const origin = trace.leg === 'outbound' ? trace.homePos : trace.destPos;
      traceStaticLayer.circle(origin.x + 0.5, origin.y + 0.5, TRACE_VIS.ORIGIN_RING_RADIUS).stroke({
        width: TRACE_VIS.ORIGIN_RING_WIDTH,
        color: theme.tracePast,
        alpha: TRACE_VIS.FUTURE_ALPHA,
      });
    }
  }

  function refreshTraces(state: GameState): void {
    const selection = traceSelection;
    if (!selection) return;
    if (!selection.isCurrent()) {
      traceSelection = null;
      clearTraces();
      return;
    }
    if (lastTraceTick === state.tick) return;
    lastTraceTick = state.tick;

    let next: TripTrace[];
    if (selection.kind === 'vehicle') {
      const trace = traceVehicle(state, selection.vehicleId);
      if (!trace) {
        traceSelection = null;
        clearTraces();
        selection.onMissing();
        return;
      }
      next = [trace];
    } else {
      next = tracesForBuilding(state, selection.buildingId, PICK.MAX_TRACES_PER_BUILDING);
    }

    const nextRenderTraces: RenderTrace[] = [];
    for (const trace of next) {
      const vehicle = state.vehicles.find((candidate) => candidate.id === trace.vehicleId);
      if (vehicle) nextRenderTraces.push({ trace, phase: vehicle.phase });
    }
    renderTraces = nextRenderTraces;
    const nextSignature = traceSignature(nextRenderTraces);
    if (nextSignature !== lastTraceSignature) {
      lastTraceSignature = nextSignature;
      drawStaticTraces();
    }
  }

  function drawDynamicTraces(views: readonly VehicleView[]): void {
    traceDynamicLayer.clear();
    for (const { trace, phase } of renderTraces) {
      if (phase !== 'road') continue;
      const view = views.find((candidate) => candidate.id === trace.vehicleId);
      const from = trace.path[trace.edgeIndex];
      const to = trace.path[trace.edgeIndex + 1];
      if (!view || !from || !to) continue;
      const current = carRenderState(view, isIntersectionTile);
      const selectedVehicle = traceSelection?.kind === 'vehicle';
      traceDynamicLayer
        .moveTo(from.x + 0.5, from.y + 0.5)
        .lineTo(current.x, current.y)
        .stroke({
          width: selectedVehicle ? TRACE_VIS.SELECTED_PAST_WIDTH : TRACE_VIS.BUILDING_PAST_WIDTH,
          color: theme.tracePast,
          alpha: TRACE_VIS.PAST_ALPHA,
          cap: 'round',
        });
      traceDynamicLayer
        .moveTo(current.x, current.y)
        .lineTo(to.x + 0.5, to.y + 0.5)
        .stroke({
          width: selectedVehicle
            ? TRACE_VIS.SELECTED_FUTURE_WIDTH
            : TRACE_VIS.BUILDING_FUTURE_WIDTH,
          color: theme.traceFuture,
          alpha: TRACE_VIS.FUTURE_ALPHA,
          cap: 'round',
        });
    }

    if (traceSelection?.kind === 'vehicle' && renderTraces[0]) {
      const trace = renderTraces[0].trace;
      const destination = trace.leg === 'outbound' ? trace.destPos : trace.homePos;
      const cycle =
        (performance.now() % TRACE_VIS.DEST_PULSE_PERIOD_MS) / TRACE_VIS.DEST_PULSE_PERIOD_MS;
      const pulse = (Math.sin(cycle * Math.PI * 2) + 1) / 2;
      const radius = TRACE_VIS.DEST_RING_RADIUS + TRACE_VIS.DEST_PULSE_RADIUS * pulse;
      traceDynamicLayer
        .circle(destination.x + 0.5, destination.y + 0.5, radius)
        .fill({ color: theme.traceFuture, alpha: TRACE_VIS.DEST_FILL_ALPHA })
        .stroke({
          width: TRACE_VIS.DEST_RING_WIDTH,
          color: theme.traceFuture,
          alpha: TRACE_VIS.FUTURE_ALPHA,
        });
    }
  }

  /** 前方4方向だけ見れば、隣接ペアごとに繋ぎが1回ずつ描かれる */
  const FORWARD: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];
  /**
   * タイル集合を「繋がった1本の道」として描く（D2/D3）。
   * タイル中心どうしを太線で結ぶので、直交も斜めも交差も同じ仕組みで繋がる。
   */
  function paintRoadLike(
    g: Graphics,
    tiles: Array<{ x: number; y: number }>,
    has: (x: number, y: number) => boolean,
    widthAt: (x: number, y: number) => number,
    color: number,
    alpha: number,
    ox = 0,
    oy = 0,
  ): void {
    // 各タイルの円でそのランクの幅を確実に塗る。接続線だけに幅を持たせると、
    // 幹線→通常道路の境界で幹線タイルの半分が細く見えてしまう。
    for (const t of tiles) {
      g.circle(t.x + 0.5 + ox, t.y + 0.5 + oy, widthAt(t.x, t.y) / 2).fill({ color, alpha });
    }
    for (const t of tiles) {
      for (const [dx, dy] of FORWARD) {
        if (!has(t.x + dx, t.y + dy)) continue;
        // 斜めは経路探索と同じ規則で判定する（`sim/road/connectivity.ts`）。
        // これをしないと、十字路の四方の腕どうしが互いに斜め隣接しているせいで
        // 斜めのショートカットが4本描かれ、交差点が「十字」ではなく**菱形**になる
        if (dx !== 0 && dy !== 0 && !diagonalAllowed(has, t.x, t.y, dx, dy)) continue;
        g.moveTo(t.x + 0.5 + ox, t.y + 0.5 + oy).lineTo(t.x + dx + 0.5 + ox, t.y + dy + 0.5 + oy);
        // 接続線は細い側へ合わせる。ランク境界で通常道路側まで太く見せない。
        const width = Math.min(widthAt(t.x, t.y), widthAt(t.x + dx, t.y + dy));
        g.stroke({ width, color, alpha, cap: 'round', join: 'round' });
      }
    }
  }

  /**
   * 交差点マーカーを描く（`docs/m4-ui-design.md` §1.3）。
   *
   * - 「交通」ツール選択中は、対象の交差点すべてに細いリングを出して
   *   **どこを触れるのかを先に見せる**
   * - 全交差点の4本の停止線を、現在通れる軸=青／止まる軸=赤で示す
   * - プレイヤー設定の優先軸は黄色い中空帯。現示の青／赤とは形と色を分ける
   * - 全赤中は sim の共通判定により4本とも赤になる
   */
  function drawIntersectionMarkers(): void {
    intersectionLayer.clear();
    for (const m of intersectionMarkers) {
      const cx = m.pos.x + 0.5;
      const cy = m.pos.y + 0.5;

      if (m.highlighted) {
        intersectionLayer
          .circle(cx, cy, MARKER.RING_RADIUS)
          .stroke({ width: MARKER.RING_WIDTH, color: theme.preview, alpha: MARKER.RING_ALPHA });
      }

      if (m.axis) {
        const horizontal = m.axis === 'horizontal';
        const bw = horizontal ? MARKER.BAND_LENGTH : MARKER.BAND_THICKNESS;
        const bh = horizontal ? MARKER.BAND_THICKNESS : MARKER.BAND_LENGTH;
        intersectionLayer
          .roundRect(cx - bw / 2, cy - bh / 2, bw, bh, MARKER.BAND_THICKNESS / 2)
          .stroke({
            width: MARKER.BAND_OUTLINE_WIDTH,
            color: theme.warn,
            alpha: MARKER.BAND_ALPHA,
          });
      }

      // 停止線。距離は sim の停止位置から導出し、色判定も sim と共用する。
      // **道路のある向きにだけ描く**（M5 §4-1）。以前は両軸×±1の4本を常に描いていたため、
      // T字路で道路の無い側にも停止線が浮いて見えるバグがあった。
      for (const { axis, sign } of intersectionStopLineDirections(m.directions)) {
        const horizontal = axis === 'horizontal';
        const color = intersectionAxisCanEnter(m.signal, axis) ? theme.preview : theme.bad;
        const sx = horizontal ? cx + sign * MARKER.STOP_DISTANCE : cx;
        const sy = horizontal ? cy : cy + sign * MARKER.STOP_DISTANCE;
        const lw = horizontal ? MARKER.STOP_THICKNESS : MARKER.STOP_LENGTH;
        const lh = horizontal ? MARKER.STOP_LENGTH : MARKER.STOP_THICKNESS;
        intersectionLayer
          .roundRect(sx - lw / 2, sy - lh / 2, lw, lh, MARKER.STOP_THICKNESS / 2)
          .fill({ color, alpha: MARKER.STOP_ALPHA });
      }
    }
  }

  function redrawWorld(state: GameState): void {
    terrainLayer.clear();
    gridLineLayer.clear();
    districtBuyableLayer.clear();
    zoneLayer.clear();
    roadLayer.clear();
    roadShadowLayer.clear();
    buildingLayer.clear();
    buildingShadowLayer.clear();
    facilityLayer.clear();

    const roadTiles: TilePos[] = [];

    for (const d of state.districts) {
      const ox = d.cx * CS;
      const oy = d.cy * CS;

      // 地形
      for (let ly = 0; ly < CS; ly++) {
        for (let lx = 0; lx < CS; lx++) {
          const x = ox + lx;
          const y = oy + ly;
          const kind = terrainAt(state.grid, x, y);
          if (kind === 'water') terrainLayer.rect(x, y, 1, 1).fill(theme.water);
          else if (kind === 'mountain') terrainLayer.rect(x, y, 1, 1).fill(theme.mountain);
          else if (kind === 'forest') terrainLayer.rect(x, y, 1, 1).fill(theme.forest);
          // plain は背景色と同じなので描かない（描画コスト削減）

          const z = zoneAt(state.grid, x, y);
          if (z) {
            zoneLayer.rect(x + 0.06, y + 0.06, 0.88, 0.88).fill({
              color: zoneColor(theme, z),
              alpha: 0.28,
            });
          }

          if (hasRoad(state.grid, x, y)) roadTiles.push({ x, y });
        }
      }

      // チャンク境界。どこまで買ってあるかが分かる。
      //
      // **実機のスクリーンショットで確認した「時々見える黒い細い線」の正体はこれだった**
      // （M5 §4-2）。32タイルごとに1本しか無いので、境界が画面の外にあるフレームでは
      // 見えず「時々見える」の報告と一致していた。境界を示す意図自体は要るので消さず、
      // `gridLineStrong`（他の交差点・道路と張り合う強さ）ではなく控えめな `gridLine` へ、
      // alpha も落として地形と喧嘩しない見え方にする。
      gridLineLayer
        .rect(ox, oy, CS, CS)
        .stroke({ width: 0.05, color: theme.gridLine, alpha: 0.45 });
    }

    const has = (x: number, y: number) => hasRoad(state.grid, x, y);
    const widthAt = (x: number, y: number) => roadRenderWidth(roadRankAt(state.grid, x, y));
    paintRoadLike(
      roadShadowLayer,
      roadTiles,
      has,
      widthAt,
      theme.shadow,
      theme.shadowAlpha,
      0.04,
      0.08,
    );
    paintRoadLike(roadLayer, roadTiles, has, widthAt, theme.road, 1);

    // 交差点タイルの列挙は道路の再描画時に事前計算する（車線オフセットの弱め用。
    // `drawCars` は毎フレーム呼ばれるので、そちらでは数え直さない）
    const nextIntersections = new Map<number, Set<number>>();
    for (const t of roadTiles) {
      if (countRoadConnections(has, t.x, t.y) < 3) continue;
      let col = nextIntersections.get(t.x);
      if (!col) {
        col = new Set<number>();
        nextIntersections.set(t.x, col);
      }
      col.add(t.y);
    }
    intersectionsByX = nextIntersections;

    // 建物。平常値までは発展が明瞭に見え、それ以上は控えめに育つ。
    // 退去ライン未満だけに警告を出し、平常的な街を警告だらけにしない。
    for (const b of state.buildings) {
      const c = zoneColor(theme, b.zone);
      const recovery =
        (b.satisfaction - GROWTH.ABANDON_THRESHOLD) /
        (GROWTH.SATISFACTION_START - GROWTH.ABANDON_THRESHOLD);
      const healthyBonus =
        Math.max(0, b.satisfaction - GROWTH.SATISFACTION_START) /
        (GROWTH.SATISFACTION_MAX - GROWTH.SATISFACTION_START);
      const development = Math.max(0, Math.min(1, recovery)) + healthyBonus * 0.25;
      const size = b.occupied ? 0.46 + development * 0.16 : 0.44;
      const m = (1 - size) / 2;
      if (b.occupied) {
        buildingShadowLayer
          .roundRect(b.pos.x + m + 0.05, b.pos.y + m + 0.09, size, size, 0.1)
          .fill({ color: theme.shadow, alpha: theme.shadowAlpha });
      }
      buildingLayer
        .roundRect(b.pos.x + m, b.pos.y + m, size, size, 0.1)
        .fill({ color: c, alpha: b.occupied ? 0.62 + development * 0.3 : 0.45 });
      if (b.occupied && b.satisfaction < GROWTH.ABANDON_THRESHOLD) {
        buildingLayer
          .circle(b.pos.x + 0.77, b.pos.y + 0.23, 0.09)
          .fill({ color: theme.bad, alpha: 1 });
      }
    }

    drawBuyableChunks(state);
    drawFacilities(state);
  }

  /**
   * 買える土地（`docs/m6-plan.md` §2 W1）。解放済みチャンクに隣接する未購入チャンクを
   * 薄く塗る。人口300のマイルストーンに届くまでは `districtLocked`（中立色）で
   * 「まだ選択肢に無い」ことを示し、届いていれば `preview`（買える・青）か
   * `previewInvalid`（買えるが今は資金が足りない・赤）で見せる——
   * 「資金が足りなければ押す前に分かる」の地図側の担保（購入パネルでも確認できる）。
   */
  function drawBuyableChunks(state: GameState): void {
    const buyable = listBuyableChunks(state.districts);
    if (buyable.length === 0) return;
    const unlocked = isUnlocked(state.progress.achievedMilestones, 'district');
    const price = districtPrice(state);
    const affordable = state.money >= price;
    const color = !unlocked ? theme.districtLocked : affordable ? theme.preview : theme.previewInvalid;
    for (const c of buyable) {
      const ox = c.cx * CS;
      const oy = c.cy * CS;
      districtBuyableLayer.rect(ox, oy, CS, CS).fill({ color, alpha: 0.14 });
      districtBuyableLayer
        .rect(ox + 0.5, oy + 0.5, CS - 1, CS - 1)
        .stroke({ width: 0.3, color, alpha: 0.5 });
    }
  }

  /**
   * 施設（`docs/m6-plan.md` §2 W4）。まだ sim 側の設置は実装されていないため
   * `state.facilities` は常に空のはずだが、データが来た時点でそのまま描けるように
   * 先に用意しておく。学校（`extraTripRate > 0` ＝交通負荷を生む施設）だけ
   * 警告色の細い縁取りを足し、公園との違いを地図上でも見分けられるようにする。
   */
  function drawFacilities(state: GameState): void {
    for (const f of state.facilities) {
      const def = facilityDef(f.defId);
      if (!def) continue;
      const size = def.footprint === 4 ? 2 : 1;
      facilityLayer
        .roundRect(f.pos.x + 0.06, f.pos.y + 0.06, size - 0.12, size - 0.12, 0.14)
        .fill({ color: theme.facility, alpha: 0.9 });
      if (def.extraTripRate > 0) {
        facilityLayer
          .roundRect(f.pos.x + 0.06, f.pos.y + 0.06, size - 0.12, size - 0.12, 0.14)
          .stroke({ width: 0.06, color: theme.warn, alpha: 0.9 });
      }
    }
  }

  function drawPreview(state: GameState): void {
    previewLayer.clear();
    if (preview.length > 0) {
      const keys = new Set(preview.map((t) => `${t.x},${t.y}`));
      const has = (x: number, y: number) => keys.has(`${x},${y}`);
      // 確定後と同じ形で見せる（プレビューだけ別の形だと仕上がりが読めない）
      paintRoadLike(
        previewLayer,
        preview.filter((t) => t.valid),
        has,
        () => ROAD_W,
        theme.preview,
        0.85,
      );
      paintRoadLike(
        previewLayer,
        preview.filter((t) => !t.valid),
        has,
        () => ROAD_W,
        theme.previewInvalid,
        0.85,
      );
    }
    drawFacilityPreview();
    void state;
  }

  /**
   * 施設の設置プレビュー（`docs/m6-plan.md` §2 W4）。
   *
   * footprint（置く場所そのもの）は道路・区画と同じ緑/赤の約束で塗る。
   * その外側に効果範囲（チェビシェフ距離＝正方形。`FacilityDef.radius`）の枠を
   * 重ねて描くことで、**置く前に「どこに置くと何に効くか」が見える**ようにする
   * （`docs/m6-plan.md` §2 W4 の受け入れ基準）。
   */
  function drawFacilityPreview(): void {
    if (!facilityPreview) return;
    for (const t of facilityPreview.footprint) {
      previewLayer
        .roundRect(t.x + 0.08, t.y + 0.08, 0.84, 0.84, 0.12)
        .fill({ color: t.valid ? theme.preview : theme.previewInvalid, alpha: 0.55 });
    }
    const { x0, y0, x1, y1 } = facilityPreview.bounds;
    previewLayer
      .rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
      .stroke({ width: 0.06, color: theme.preview, alpha: 0.6 });
  }

  function drawCars(views: VehicleView[]): void {
    carLayer.clear();
    carShadowLayer.clear();
    ensureCarRenderCapacity(views.length);

    const now = performance.now();
    const elapsedSeconds = previousCarFrameMs === null ? 0 : (now - previousCarFrameMs) / 1000;
    const validElapsedSeconds =
      elapsedSeconds > 0 && elapsedSeconds <= MAX_BRAKE_FRAME_SECONDS ? elapsedSeconds : 0;
    const expectedDistance = TRAFFIC.VMAX * validElapsedSeconds;
    previousCarFrameMs = now;
    carFrame++;

    for (let i = 0; i < views.length; i++) {
      const v = views[i]!;
      const state = carRenderState(v, isIntersectionTile);
      const cos = Math.cos(state.angle);
      const sin = Math.sin(state.angle);
      renderX[i] = state.x;
      renderY[i] = state.y;
      renderCos[i] = cos;
      renderSin[i] = sin;

      const previous = previousCarPositions.get(v.id);
      // ACCESS_SPEED は意図的に遅いので、アクセス中を「制動」と誤認して点灯させない。
      renderBrake[i] =
        (v.phase ?? 'road') === 'road' && previous && expectedDistance > 0
          ? brakeIntensity(Math.hypot(state.x - previous.x, state.y - previous.y), expectedDistance)
          : 0;
      if (previous) {
        previous.x = state.x;
        previous.y = state.y;
        previous.lastSeenFrame = carFrame;
      } else {
        // 生成は車が初めて現れたときだけ。通常フレームでは既存オブジェクトを書き換える。
        previousCarPositions.set(v.id, { x: state.x, y: state.y, lastSeenFrame: carFrame });
      }
    }

    // 毎フレーム全idを照合・deleteすると高くつくため、約10秒ごとにだけ古い履歴を掃除する。
    if (carFrame % BRAKE_HISTORY_CLEANUP_FRAMES === 0) {
      const oldestFrame = carFrame - BRAKE_HISTORY_CLEANUP_FRAMES;
      for (const [id, position] of previousCarPositions) {
        if (position.lastSeenFrame <= oldestFrame) previousCarPositions.delete(id);
      }
    }

    function appendPart(
      g: Graphics,
      i: number,
      offset: number,
      length: number,
      width: number,
      radius: number,
      shadow = false,
    ): void {
      const ox = shadow ? 0.03 : 0;
      const oy = shadow ? 0.05 : 0;
      const x = renderX[i]!;
      const y = renderY[i]!;
      const cos = renderCos[i]!;
      const sin = renderSin[i]!;
      appendRotatedRoundRect(
        g,
        x + cos * offset + ox,
        y + sin * offset + oy,
        cos,
        sin,
        length,
        width,
        radius,
      );
    }

    function drawPart(
      kind: VehicleView['kind'],
      offset: number,
      length: number,
      width: number,
      radius: number,
      color: number,
    ): void {
      let count = 0;
      for (let i = 0; i < views.length; i++) {
        if (views[i]!.kind !== kind) continue;
        appendPart(carLayer, i, offset, length, width, radius);
        count++;
      }
      // フェードしないため、同じ色の全車を1回のfillへまとめられる。
      if (count > 0) carLayer.fill({ color, alpha: 1 });
    }

    let shadowCount = 0;
    for (let i = 0; i < views.length; i++) {
      const v = views[i]!;
      const dimensions = carDimensions(v.kind);
      appendPart(
        carShadowLayer,
        i,
        0,
        dimensions.length,
        dimensions.width,
        v.kind === 'truck' ? TRUCK_BED_RADIUS : CAR_RADIUS,
        true,
      );
      shadowCount++;
    }
    if (shadowCount > 0) {
      carShadowLayer.fill({ color: theme.shadow, alpha: theme.shadowAlpha });
    }

    drawPart('car', 0, CAR_LENGTH, CAR_WIDTH, CAR_RADIUS, theme.vehicleCar);
    drawPart(
      'truck',
      TRUCK_CAB_OFFSET,
      TRUCK_CAB_LENGTH,
      TRUCK_CAB_WIDTH,
      TRUCK_CAB_RADIUS,
      theme.vehicleTruck,
    );
    drawPart(
      'truck',
      TRUCK_BED_OFFSET,
      TRUCK_BED_LENGTH,
      TRUCK_BED_WIDTH,
      TRUCK_BED_RADIUS,
      truckBedColor,
    );
    drawPart(
      'car',
      CAR_CABIN_OFFSET,
      CAR_CABIN_LENGTH,
      CAR_CABIN_WIDTH,
      CAR_CABIN_RADIUS,
      carCabinColor,
    );

    // 完全停止（強さ1）のランプはまとめて塗り、減速中だけ可変alphaで個別に塗る。
    let stoppedCount = 0;
    for (let i = 0; i < views.length; i++) {
      if (renderBrake[i]! < 1) continue;
      const length = views[i]!.kind === 'truck' ? TRUCK_LENGTH : CAR_LENGTH;
      carLayer.circle(
        renderX[i]! - renderCos[i]! * (length / 2),
        renderY[i]! - renderSin[i]! * (length / 2),
        BRAKE_DIAMETER / 2,
      );
      stoppedCount++;
    }
    if (stoppedCount > 0) carLayer.fill({ color: theme.bad, alpha: 1 });
    for (let i = 0; i < views.length; i++) {
      const intensity = renderBrake[i]!;
      if (intensity <= 0 || intensity >= 1) continue;
      const length = views[i]!.kind === 'truck' ? TRUCK_LENGTH : CAR_LENGTH;
      carLayer
        .circle(
          renderX[i]! - renderCos[i]! * (length / 2),
          renderY[i]! - renderSin[i]! * (length / 2),
          BRAKE_DIAMETER / 2,
        )
        .fill({ color: theme.bad, alpha: BRAKE_MIN_ALPHA + (1 - BRAKE_MIN_ALPHA) * intensity });
    }
  }

  function applyCamera(cam: Camera): void {
    // app.screen は論理（CSS）サイズ。renderer.width は描画バッファのサイズで
    // resolution が掛かっているため、ここで使うと中心がずれる
    const w = app.screen.width;
    const h = app.screen.height;
    const s = tileScreenSize(cam);
    const origin = worldToScreen(cam, 0, 0, w, h);
    world.scale.set(s);
    world.position.set(origin.x, origin.y);
  }

  return {
    app,
    markDirty() {
      dirty = true;
    },
    setPreview(tiles) {
      preview = tiles;
      dirty = true;
    },
    setFacilityPreview(next) {
      facilityPreview = next;
      dirty = true;
    },
    setIntersectionMarkers(markers) {
      intersectionMarkers = markers;
      intersectionDirty = true;
    },
    pickVehicle(point) {
      return pickVehicleAt(lastRenderedVehicles, point, isIntersectionTile);
    },
    setTraceSelection(selection) {
      traceSelection = selection;
      clearTraces();
    },
    setOverlay(draw) {
      overlayDraw = draw;
      // 消灯時に前回の絵を残さない
      if (!draw) overlayLayer.clear();
    },
    render(world, vehicles, cam, flow) {
      const state = world.state;
      lastRenderedVehicles = vehicles;
      if (dirty) {
        redrawWorld(state);
        drawPreview(state);
        dirty = false;
      }
      if (intersectionDirty) {
        drawIntersectionMarkers();
        intersectionDirty = false;
      }
      // オーバーレイは dirty 任せにできない。混雑度は毎tick変わるのに
      // 建設操作は起きないので、dirty だけで描き直すと数字が固まって見える。
      // 有効なときだけ毎フレーム描き直す（既定は消灯なのでコストゼロ）
      if (overlayDraw) {
        overlayLayer.clear();
        // 経路オーバーレイ（M5 §4-4）は加算合成にするため blendMode を 'add' にするが、
        // それが前フレームのまま残ると他のモードの塗りまで加算合成になってしまう。
        // 呼ぶ直前に既定へ戻し、必要なモードだけが自分で 'add' に切り替える。
        overlayLayer.blendMode = 'normal';
        overlayDraw(overlayLayer, {
          state,
          congestion: world.congestion,
          flow,
          theme,
        });
      }
      refreshTraces(state);
      drawDynamicTraces(vehicles);
      drawCars(vehicles);
      applyCamera(cam);
    },
    destroy() {
      app.destroy(true, { children: true });
    },
  };
}
