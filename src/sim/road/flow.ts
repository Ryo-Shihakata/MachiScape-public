/**
 * 道路タイルごとの「通過実績」の移動平均（M5 §4-3・流量オーバーレイ）。
 *
 * 混雑度（`congestion.ts`）は「いまタイルに何台いるか」を CAPACITY 比で見る短期指標
 * （密度）。こちらは「これまでどれだけの車がこのタイルを通り過ぎたか」という
 * 長期の実績（スループット）を見せたいので、別のマップ・別の EMA 係数
 * （`ANALYSIS.FLOW_ALPHA`）で独立に持つ。EMA の更新の形は `congestion.ts` の
 * `updateCongestion` を流用するが、**同じマップに混ぜない**（意味が違う値を
 * 混ぜると、渋滞と流量のどちらも読めなくなる）。
 *
 * サンプリングは sim 本体（`stepTraffic`）には入れない。あくまで描画用の実績表示で
 * あり、通行判定には一切使わないため。`game/loop.ts` が「前回サンプルとの位置」から
 * `passCountsFromViews` で通過を数え、実tickが進んだときだけ `updateFlow` を呼ぶ想定
 * （毎フレームではない）。1フレームで複数tickをまとめて消化したとき（倍速・タブ復帰）は
 * 途中のタイルの通過を取りこぼすが、傾向を見せる指標としては十分と割り切る。
 */

import { ANALYSIS } from '../balance';

export type FlowMap = Record<string, number>;

/** この値未満に減衰したエントリは削除する（`congestion.ts` と同じ肥大化防止策）。 */
const PRUNE_EPSILON = 0.001;

export function createFlowMap(): FlowMap {
  return {};
}

export function flowAt(map: FlowMap, x: number, y: number): number {
  return map[`${x},${y}`] ?? 0;
}

/**
 * 直近サンプルの通過回数（`passCountsFromViews` の戻り値）を目標値として、
 * `ANALYSIS.FLOW_ALPHA` の指数移動平均で更新する。通過が無かったタイルも
 * 追跡中なら目標値0として減衰させる（`updateCongestion` と同じ形）。
 */
export function updateFlow(map: FlowMap, passCounts: Readonly<Record<string, number>>): void {
  const keys = new Set<string>([...Object.keys(map), ...Object.keys(passCounts)]);
  for (const key of keys) {
    const target = passCounts[key] ?? 0;
    const prev = map[key] ?? 0;
    const next = prev + ANALYSIS.FLOW_ALPHA * (target - prev);
    if (next < PRUNE_EPSILON) {
      delete map[key];
    } else {
      map[key] = next;
    }
  }
}

/** `passCountsFromViews` が読む最小限の車両サンプル点。`VehicleView` はこれを満たす。 */
export interface FlowSamplePoint {
  id: number;
  x: number;
  y: number;
  phase?: string;
}

/**
 * 前回サンプルと今回サンプルの位置を比べ、道路タイルを「新しく跨いだ」ものだけを
 * 1回の通過として数える。
 *
 * **同じタイルに留まっている間は何度も数えない。** タイルの占有時間で数えると、
 * 詰まって遅い道ほど「よく使われている」ことになり、混雑度と見分けが付かなくなる
 * （流量＝スループットであり、密度ではない）。
 *
 * `phase !== 'road'` は建物への私道アクセス中なので対象外にする
 * （流量は道路網の実績を見せるもので、私道タイルは道路グリッドに存在しない）。
 */
export function passCountsFromViews(
  prev: ReadonlyMap<number, { x: number; y: number }>,
  curr: readonly FlowSamplePoint[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of curr) {
    if (v.phase !== 'road') continue;
    const tx = Math.round(v.x - 0.5);
    const ty = Math.round(v.y - 0.5);
    const previous = prev.get(v.id);
    if (previous) {
      const px = Math.round(previous.x - 0.5);
      const py = Math.round(previous.y - 0.5);
      if (px === tx && py === ty) continue;
    }
    const key = `${tx},${ty}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
