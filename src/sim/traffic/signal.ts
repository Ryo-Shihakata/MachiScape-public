import { TRAFFIC } from '../balance';
import {
  tileKey,
  type GameState,
  type IntersectionAxis,
  type IntersectionSignalState,
  type TilePos,
} from '../types';

/** 描画と挙動が共有する、現在の信号現示。 */
export interface IntersectionSignalView {
  phase: IntersectionSignalState['phase'];
  /** null は全赤。値があるとき、その軸だけが新規進入できる。 */
  greenAxis: IntersectionAxis | null;
  elapsedTicks: number;
  /** 現在の最低保持／全赤クリアランスが終わるまでの残りtick。 */
  remainingTicks: number;
}

function oppositeAxis(axis: IntersectionAxis): IntersectionAxis {
  return axis === 'horizontal' ? 'vertical' : 'horizontal';
}

/**
 * 新設交差点の既定現示。
 *
 * プレイヤー指定があればその軸を既定の青にする。指定がなければ、保存済みの最終サービス軸
 * と反対側（履歴もなければ水平）を選ぶため、旧セーブからの移行も決定論的になる。
 */
export function initialIntersectionSignalAxis(state: GameState, pos: TilePos): IntersectionAxis {
  const key = tileKey(pos.x, pos.y);
  const priority = state.intersectionPriorities?.[key];
  if (priority) return priority;
  const lastServed = state.intersectionLastServedAxes?.[key];
  return lastServed ? oppositeAxis(lastServed) : 'horizontal';
}

/** 交差点の保存現示を作る。道路建設時と旧セーブの遅延移行から共用する。 */
export function ensureIntersectionSignal(state: GameState, pos: TilePos): IntersectionSignalState {
  state.intersectionSignals ??= {};
  const key = tileKey(pos.x, pos.y);
  const existing = state.intersectionSignals[key];
  if (existing) return existing;
  const created: IntersectionSignalState = {
    phase: 'green',
    greenAxis: initialIntersectionSignalAxis(state, pos),
    phaseStartedTick: state.tick,
  };
  state.intersectionSignals[key] = created;
  return created;
}

/** 優先軸は通常軸より長い最低青時間を持つ。優先設定は即時の危険な反転には使わない。 */
export function minimumGreenTicks(state: GameState, key: string, axis: IntersectionAxis): number {
  const priority = state.intersectionPriorities?.[key];
  if (!priority) return TRAFFIC.SIGNAL_MIN_GREEN_TICKS;
  return priority === axis
    ? TRAFFIC.SIGNAL_PRIORITY_MIN_GREEN_TICKS
    : TRAFFIC.SIGNAL_PRIORITY_MINOR_GREEN_TICKS;
}

/**
 * 表示と車両制御の単一情報源。保存状態がない旧セーブは、決定論的な既定青として読む。
 */
export function intersectionSignalAt(state: GameState, pos: TilePos): IntersectionSignalView {
  const key = tileKey(pos.x, pos.y);
  const signal = state.intersectionSignals?.[key];
  if (!signal) {
    return {
      phase: 'green',
      greenAxis: initialIntersectionSignalAxis(state, pos),
      elapsedTicks: 0,
      remainingTicks: minimumGreenTicks(state, key, initialIntersectionSignalAxis(state, pos)),
    };
  }
  const elapsedTicks = Math.max(0, state.tick - signal.phaseStartedTick);
  const duration =
    signal.phase === 'allRed'
      ? TRAFFIC.SIGNAL_ALL_RED_TICKS
      : minimumGreenTicks(state, key, signal.greenAxis);
  return {
    phase: signal.phase,
    greenAxis: signal.greenAxis,
    elapsedTicks,
    remainingTicks: Math.max(0, duration - elapsedTicks),
  };
}

/** 描画の青／赤判定と、sim の新規進入許可が必ず一致するための共通関数。 */
export function intersectionAxisCanEnter(
  signal: Pick<IntersectionSignalView, 'greenAxis'>,
  axis: IntersectionAxis,
): boolean {
  return signal.greenAxis === axis;
}
