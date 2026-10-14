import { describe, expect, it } from 'vitest';
import { nextRoadMode } from './App';
import type { RoadMode } from './store';

/**
 * `nextRoadMode` は道路ツールの Digit2 連打での巡回（`docs/m4-trace-design.md` T7 §5）を
 * 担う純粋関数: 通常 → 幹線 → 縮小 → 通常 → …
 * `src/game/loop.ts` の `nextIntersectionAxis` と同じ理由（ダイアログを出さず
 * キー入力だけで即時に状態を進めるための唯一のロジック）で、巡回順そのものをここで固定する。
 */
describe('nextRoadMode', () => {
  it('通常（normal）から幹線（arterial）へ進む', () => {
    expect(nextRoadMode('normal')).toBe('arterial');
  });

  it('幹線（arterial）から縮小（shrink）へ進む', () => {
    expect(nextRoadMode('arterial')).toBe('shrink');
  });

  it('縮小（shrink）から通常（normal）へ戻る', () => {
    expect(nextRoadMode('shrink')).toBe('normal');
  });

  it('3回押すと1周して同じ値に戻る', () => {
    let mode: RoadMode = 'normal';
    const seen: RoadMode[] = [mode];
    for (let i = 0; i < 3; i++) {
      mode = nextRoadMode(mode);
      seen.push(mode);
    }
    expect(seen).toEqual(['normal', 'arterial', 'shrink', 'normal']);
  });
});
