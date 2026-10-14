/** 日次のマイルストーン達成判定。 */

import { GROWTH } from '../balance';
import type { GameState } from '../types';
import { MILESTONES } from './milestones';

/**
 * 現在人口で新たに達成したマイルストーンを記録し、今回の報奨金合計を返す。
 *
 * 報奨金は同じ日の精算内訳へ載せるため、`world.ts` が戻り値を `settleDay` に渡す。
 * 達成済み id は削除せず、同じマイルストーンを二度支給しない。
 */
export function checkMilestones(state: GameState): number {
  let occupiedHomes = 0;
  for (const building of state.buildings) {
    if (building.occupied && building.zone === 'residential') occupiedHomes++;
  }
  const population = occupiedHomes * GROWTH.POP_PER_BUILDING;
  let rewards = 0;
  for (const milestone of MILESTONES) {
    if (population < milestone.pop) break;
    if (state.progress.achievedMilestones.includes(milestone.id)) continue;
    state.progress.achievedMilestones.push(milestone.id);
    rewards += milestone.rewardMoney;
  }
  return rewards;
}

export * from './milestones';
