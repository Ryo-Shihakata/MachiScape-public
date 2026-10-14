import { describe, expect, it } from 'vitest';
import { TOOLBAR_ORDER, facilityUnlockPop, isFacilityUnlocked } from './Toolbar';
import { FACILITY_DEFS } from '../../sim/facility/defs';
import { MILESTONES } from '../../sim/progress/milestones';

/**
 * §3-1: 「パン / 道路 / 区画 / 施設 / 交通 / 分析 / （余白） / 撤去」。
 * 撤去は破壊的操作なので、並びの一番最後（＝画面の右端）に隔離する。
 * `TOOLBAR_ORDER` は Toolbar.tsx が実際に描く左→右の並びそのもの。
 */
describe('ツールバーの並び（§3-1、M6で施設を追加）', () => {
  it('撤去（demolish）が配列の最後にある', () => {
    expect(TOOLBAR_ORDER.at(-1)).toBe('demolish');
  });

  it('撤去は最後の1回しか出てこない（本体の並びに紛れ込んでいない）', () => {
    const demolishCount = TOOLBAR_ORDER.filter((t) => t === 'demolish').length;
    expect(demolishCount).toBe(1);
  });

  it('先頭から撤去の手前までは パン/道路/区画/施設/交通/分析 の順', () => {
    expect(TOOLBAR_ORDER.slice(0, -1)).toEqual([
      'pan',
      'road',
      'zone',
      'facility',
      'traffic',
      'analysis',
    ]);
  });
});

/**
 * 施設のロック表示（`docs/m6-plan.md` §2 W4）。`FACILITY_DEFS` は実データを使う——
 * 配列をベタ書きしたテストにすると、defs.ts 側の解放条件が変わっても
 * テストだけが古いまま緑になってしまう。
 */
describe('isFacilityUnlocked（施設のロック判定）', () => {
  const park = FACILITY_DEFS.find((d) => d.id === 'park')!;
  const school = FACILITY_DEFS.find((d) => d.id === 'school')!;

  it('unlock: "start" の施設（公園）は常に解放済み', () => {
    expect(isFacilityUnlocked(park, [])).toBe(true);
    expect(isFacilityUnlocked(park, ['pop100'])).toBe(true);
  });

  it('マイルストーン解放の施設（学校）は、対応するマイルストーン未達成の間ロックされる', () => {
    expect(isFacilityUnlocked(school, [])).toBe(false);
  });

  it('対応するマイルストーンを達成すると解放される', () => {
    expect(isFacilityUnlocked(school, ['pop100'])).toBe(true);
  });

  it('無関係なマイルストーンだけでは解放されない', () => {
    expect(isFacilityUnlocked(school, ['pop2000'])).toBe(false);
  });
});

describe('facilityUnlockPop（ロック中の施設の「何をすれば解放されるか」）', () => {
  it('unlock: "start" の施設は null（表示側は「常に解放済み」として扱う）', () => {
    const park = FACILITY_DEFS.find((d) => d.id === 'park')!;
    expect(facilityUnlockPop(park)).toBeNull();
  });

  it('学校は pop100 のマイルストーンで解放されるので、必要人口は100', () => {
    const school = FACILITY_DEFS.find((d) => d.id === 'school')!;
    const pop100 = MILESTONES.find((m) => m.id === 'pop100')!;
    expect(facilityUnlockPop(school)).toBe(pop100.pop);
  });
});
