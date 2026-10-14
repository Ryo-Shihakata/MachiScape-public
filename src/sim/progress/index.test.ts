import { describe, expect, it } from 'vitest';
import { GROWTH, MILESTONE } from '../balance';
import type { Building } from '../types';
import { createWorld, stepDay } from '../world';
import { checkMilestones, isUnlocked } from '.';

function addHomes(world: ReturnType<typeof createWorld>, count: number): void {
  for (let i = 0; i < count; i++) {
    const building: Building = {
      id: world.state.nextId++,
      pos: { x: i % 32, y: Math.floor(i / 32) },
      zone: 'residential',
      level: 1,
      occupied: true,
      satisfaction: 50,
      lowSatisfactionDays: 0,
      tripsOkToday: 0,
      tripsFailToday: 0,
    };
    world.state.buildings.push(building);
  }
}

describe('マイルストーン進行', () => {
  it('現在人口までを定義順に一度だけ達成し、人口が減っても取り消さない', () => {
    const world = createWorld(1);
    addHomes(world, Math.ceil(500 / GROWTH.POP_PER_BUILDING));
    const expected = MILESTONE.REWARD_POP100 + MILESTONE.REWARD_POP300 + MILESTONE.REWARD_POP500;

    expect(checkMilestones(world.state)).toBe(expected);
    expect(world.state.progress.achievedMilestones).toEqual(['pop100', 'pop300', 'pop500']);
    expect(isUnlocked(world.state.progress.achievedMilestones, 'school')).toBe(true);
    expect(isUnlocked(world.state.progress.achievedMilestones, 'arterial')).toBe(true);
    expect(checkMilestones(world.state)).toBe(0);

    world.state.buildings.length = 0;
    expect(checkMilestones(world.state)).toBe(0);
    expect(world.state.progress.achievedMilestones).toEqual(['pop100', 'pop300', 'pop500']);
  });

  it('worldの日次処理が報奨金を残高とDayReportへ同じ日に一度だけ反映する', () => {
    const world = createWorld(2);
    addHomes(world, Math.ceil(300 / GROWTH.POP_PER_BUILDING));
    const reward = MILESTONE.REWARD_POP100 + MILESTONE.REWARD_POP300;
    const before = world.state.money;

    stepDay(world);
    const first = world.state.progress.lastDayReport!;
    expect(first.rewards).toBe(reward);
    expect(world.state.money - before).toBeCloseTo(first.taxR - first.upkeepRoad + reward);

    const afterFirst = world.state.money;
    stepDay(world);
    const second = world.state.progress.lastDayReport!;
    expect(second.rewards).toBe(0);
    expect(world.state.money - afterFirst).toBeCloseTo(second.taxR - second.upkeepRoad);
  });
});
