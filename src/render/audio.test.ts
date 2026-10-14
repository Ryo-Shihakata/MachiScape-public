import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAudioSettings,
  playSound,
  setAudioMuted,
  setAudioVolume,
  subscribeAudioSettings,
} from './audio';

afterEach(() => {
  setAudioMuted(false);
  setAudioVolume(0.5);
});

describe('効果音設定', () => {
  it('既定ではミュートされていない', () => {
    expect(getAudioSettings().muted).toBe(false);
  });

  it('音量を範囲内に丸め、変更を購読先へ通知する', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAudioSettings(listener);
    setAudioVolume(2);
    expect(getAudioSettings().volume).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('完全ミュート中も Web Audio API の無い環境で例外を出さない', () => {
    setAudioMuted(true);
    expect(getAudioSettings().muted).toBe(true);
    expect(() => playSound('milestone')).not.toThrow();
  });
});
