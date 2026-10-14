/** Web Audio API だけで鳴らす短い効果音（実装書 §14）。 */

export type SoundEffect = 'facility' | 'milestone' | 'error';

export interface AudioSettings {
  volume: number;
  muted: boolean;
}

const SETTINGS_KEY = 'machiscape.audio';
const DEFAULT_SETTINGS: AudioSettings = { volume: 0.5, muted: false };
const listeners = new Set<() => void>();

let settings = readSettings();
let context: AudioContext | null = null;

/** React の external store として読めるよう、変更時だけ新しい参照へ差し替える。 */
export function getAudioSettings(): AudioSettings {
  return settings;
}

export function subscribeAudioSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAudioVolume(volume: number): void {
  const next = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_SETTINGS.volume;
  updateSettings({ ...settings, volume: next });
  if (!settings.muted && settings.volume > 0) void unlockAudio();
}

export function setAudioMuted(muted: boolean): void {
  updateSettings({ ...settings, muted });
  if (!muted) void unlockAudio();
}

/**
 * モバイルではユーザー操作より前に作った AudioContext が停止状態になる。
 * 最初のポインタ押下から呼び、以後の sim イベントが即座に鳴る状態へ戻す。
 */
export async function unlockAudio(): Promise<void> {
  if (settings.muted || settings.volume === 0) return;
  try {
    const audio = audioContext();
    if (audio.state === 'suspended') await audio.resume();
  } catch {
    // 音が使えない環境でもゲーム本体の入力を失敗させない。
  }
}

export function playSound(effect: SoundEffect): void {
  if (settings.muted || settings.volume === 0) return;
  try {
    const audio = audioContext();
    if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
    const now = audio.currentTime;
    if (effect === 'facility') {
      tone(audio, now, 520, 0.1, 'sine', 0.55);
      tone(audio, now + 0.055, 700, 0.09, 'sine', 0.4);
      return;
    }
    if (effect === 'milestone') {
      tone(audio, now, 523.25, 0.14, 'sine', 0.45);
      tone(audio, now + 0.1, 659.25, 0.16, 'sine', 0.45);
      tone(audio, now + 0.2, 783.99, 0.24, 'sine', 0.5);
      return;
    }
    tone(audio, now, 180, 0.15, 'square', 0.28);
    tone(audio, now + 0.08, 125, 0.18, 'square', 0.22);
  } catch {
    // Web Audio API が無いテスト環境や拒否された端末でも操作結果は変えない。
  }
}

function tone(
  audio: AudioContext,
  start: number,
  frequency: number,
  duration: number,
  type: OscillatorType,
  level: number,
): void {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, settings.volume * level), start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + duration);
}

function audioContext(): AudioContext {
  context ??= new AudioContext();
  return context;
}

function updateSettings(next: AudioSettings): void {
  if (next.volume === settings.volume && next.muted === settings.muted) return;
  settings = next;
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // プライベートモード等で保存できなくても、現在のセッションの設定は維持する。
  }
  for (const listener of listeners) listener();
}

function readSettings(): AudioSettings {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      !('volume' in value) ||
      !('muted' in value) ||
      typeof value.volume !== 'number' ||
      !Number.isFinite(value.volume) ||
      typeof value.muted !== 'boolean'
    ) {
      return DEFAULT_SETTINGS;
    }
    return { volume: Math.min(1, Math.max(0, value.volume)), muted: value.muted };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
