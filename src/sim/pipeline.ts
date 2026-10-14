/**
 * 成長・日次処理の契約（実装書 §8・§9）。
 *
 * 街の発展（growth）と経済（economy）は別々のモジュールが実装するが、
 * 呼び出す順序と受け渡す型はここで固定する。順序が変わると同じ入力でも
 * 結果が変わる（＝決定論が壊れる）ので、実装側で順序を決めないこと。
 *
 * 60tickごとの処理（需要をリアルタイムに反映）:
 *   1. computeBuildingStats / computeDemand
 *   2. processMoveIn      需要に応じて空き区画へ入居させる
 *
 * 1ゲーム日の処理順（world.ts が入居後にこの順で呼ぶ）:
 *   1. processLogistics   工業の生産と商業の消費を進める
 *   2. updateSatisfaction 満足度を更新し、条件を満たした建物を退去させる
 *   3. checkMilestones    入居・退去後の人口で達成判定し、報奨金を確定する
 *   4. settleDay          税収・維持費・報奨金を精算し、日次レポートを残す
 *
 * 物流要求は毎tick関数を呼ぶが、building.id由来の時刻に一致する商業だけを
 * 1日1回処理する。日次境界では logistics と satisfaction の間に入る。
 *
 * すべて `(state, rng) => void` 系の副作用関数で、GameState を直接書き換える。
 * 戻り値で状態を作り直さないのは、車両1500台ぶんのコピーを毎日作らないため。
 */

import type { GameState, ZoneType } from './types';
import type { Rng } from './rng';

/** RCI 需要（-100..100 にクランプ済み） */
export interface Demand {
  residential: number;
  commercial: number;
  industrial: number;
}

/** 建物の集計。入居間隔ごとの需要計算と日次精算で共有するスナップショット */
export interface BuildingStats {
  /** 入居済みの棟数 */
  occupied: Record<ZoneType, number>;
  /** 建設済みの棟数（入居の有無を問わない） */
  built: Record<ZoneType, number>;
  population: number;
  /** 直近1日の失敗率 0..1 */
  recentTripFailRate: number;
}

export type ComputeDemand = (state: GameState, stats: BuildingStats) => Demand;
export type ProcessMoveIn = (
  state: GameState,
  stats: BuildingStats,
  demand: Demand,
  rng: Rng,
) => void;
export type ProcessLogistics = (state: GameState) => void;
export type UpdateSatisfaction = (state: GameState) => void;
export type SettleDay = (state: GameState, stats: BuildingStats, rewards?: number) => void;
