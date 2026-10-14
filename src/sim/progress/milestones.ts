/**
 * マイルストーン定義（実装書 §11・`docs/m6-plan.md` §2 W3）。
 *
 * **条件は人口だけにしてある。** 計画では「3日連続で処理率85%以上」という
 * 品質ゲートを置くつもりだったが、実測で取り下げた（`docs/m6-plan.md` §1-4）。
 * 処理率は密な道路網でもスカスカな道路網でもほぼ同じ値になる——街は
 * 「移動時間が同じくらいになるまで」成長して止まるので、**道路網の質は
 * 処理率ではなく街の大きさに現れる**。条件に使っても意味を持たない。
 *
 * 処理率に使い道が無いわけではない。絶対値ではなく「昨日より悪くなったか」と
 * 「どの住宅が出られずにいるか」なら意味を持つので、そちらで使う。
 */

import { MILESTONE } from '../balance';

export interface MilestoneDef {
  id: string;
  /** 達成に必要な人口 */
  pop: number;
  /** 達成時の一時金 */
  rewardMoney: number;
  /**
   * 解放されるもの。施設の `unlock.milestoneId` と、UI 側の機能ロックが参照する。
   *
   * **報奨金より解放の方が重要。** 日次黒字が貯まり続ける以上、金は最終的に
   * 待ち時間にしかならない（`docs/m6-plan.md` §2 W5）。
   */
  unlocks: readonly string[];
}

/** 人口の小さい順に並べること（達成判定がこの順に依存する） */
export const MILESTONES: readonly MilestoneDef[] = [
  { id: 'pop100', pop: 100, rewardMoney: MILESTONE.REWARD_POP100, unlocks: ['school'] },
  { id: 'pop300', pop: 300, rewardMoney: MILESTONE.REWARD_POP300, unlocks: ['district'] },
  { id: 'pop500', pop: 500, rewardMoney: MILESTONE.REWARD_POP500, unlocks: ['arterial'] },
  { id: 'pop1000', pop: 1000, rewardMoney: MILESTONE.REWARD_POP1000, unlocks: ['speed3x'] },
  { id: 'pop2000', pop: 2000, rewardMoney: MILESTONE.REWARD_POP2000, unlocks: [] },
];

/**
 * まだ達成していないマイルストーンのうち、次に来るもの。全部達成済みなら null。
 *
 * UI が「次の目標まであと何人か」を出すために使う。**数値だけ出して放置しないこと**が
 * 設計上の要点で、達成条件と現在値の差を必ず言葉にする。
 */
export function nextMilestone(achieved: readonly string[]): MilestoneDef | null {
  return MILESTONES.find((m) => !achieved.includes(m.id)) ?? null;
}

/** その機能が解放済みか。未解放の施設・ツールを UI がロック表示するために使う */
export function isUnlocked(achieved: readonly string[], key: string): boolean {
  return MILESTONES.some((m) => achieved.includes(m.id) && m.unlocks.includes(key));
}
