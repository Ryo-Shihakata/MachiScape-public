import { describe, expect, it } from 'vitest';
import { milestoneProgressFor, newlyAchieved } from './MilestoneBar';
import { MILESTONES } from '../../sim/progress/milestones';
import { tp } from '../../i18n/ja';

/**
 * `milestoneProgressFor`（`docs/m6-plan.md` §2 W3）。
 *
 * 「次の目標まであと何人か」を数値だけ出して放置しないこと、というのが
 * この計画の要点。ここでは実データ（`MILESTONES`）を使い、数値そのものと、
 * `tp()` に通した実際の文言の両方を確認する。
 */
describe('milestoneProgressFor（次の目標まであと何人）', () => {
  const pop100 = MILESTONES.find((m) => m.id === 'pop100')!;

  it('未達成のとき、次の目標は人口の一番小さいマイルストーン（pop100）', () => {
    const progress = milestoneProgressFor(0, []);
    expect(progress.next?.id).toBe('pop100');
    expect(progress.remaining).toBe(pop100.pop);
  });

  it('現在の人口から、次の目標までの残り人数が正しく計算される', () => {
    const progress = milestoneProgressFor(37, []);
    expect(progress.remaining).toBe(pop100.pop - 37);
  });

  it('文言（tp経由）が実際の残り人数を含んで組み立てられる', () => {
    const progress = milestoneProgressFor(60, []);
    const text = tp('milestone.remaining', { n: progress.remaining });
    expect(text).toBe(`次の目標まであと ${pop100.pop - 60} 人`);
  });

  it('人口が目標を超えていても、残り人数は負にならない（0で頭打ち）', () => {
    const progress = milestoneProgressFor(pop100.pop + 50, ['pop100']);
    // pop100 を達成済みにすると次は pop300 になる
    const pop300 = MILESTONES.find((m) => m.id === 'pop300')!;
    expect(progress.next?.id).toBe('pop300');
    expect(progress.remaining).toBe(pop300.pop - (pop100.pop + 50));
    expect(progress.remaining).toBeGreaterThanOrEqual(0);
  });

  it('達成済みでも次の目標の人口を下回るところまで巻き戻れば残りは正しく増える', () => {
    // pop100 は達成済みだが人口はまだ pop300 に届いていないケース
    const progress = milestoneProgressFor(150, ['pop100']);
    const pop300 = MILESTONES.find((m) => m.id === 'pop300')!;
    expect(progress.remaining).toBe(pop300.pop - 150);
  });

  it('全マイルストーンを達成済みなら next は null、remaining は0', () => {
    const allIds = MILESTONES.map((m) => m.id);
    const progress = milestoneProgressFor(999_999, allIds);
    expect(progress.next).toBeNull();
    expect(progress.remaining).toBe(0);
  });

  it('進捗率（ratio）は直前のマイルストーンからの区間で0..1に収まる', () => {
    const pop300 = MILESTONES.find((m) => m.id === 'pop300')!;
    const halfway = Math.round((pop100.pop + pop300.pop) / 2);
    const progress = milestoneProgressFor(halfway, ['pop100']);
    expect(progress.ratio).toBeGreaterThan(0);
    expect(progress.ratio).toBeLessThan(1);
  });
});

describe('newlyAchieved（達成バナー用の差分）', () => {
  it('前回に無く今回だけあるIDを返す', () => {
    expect(newlyAchieved([], ['pop100'])).toEqual(['pop100']);
  });

  it('前回と同じなら何も返らない', () => {
    expect(newlyAchieved(['pop100'], ['pop100'])).toEqual([]);
  });

  it('複数同時に達成しても、新しいものだけを順序を保って返す', () => {
    expect(newlyAchieved(['pop100'], ['pop100', 'pop300', 'pop500'])).toEqual(['pop300', 'pop500']);
  });
});
