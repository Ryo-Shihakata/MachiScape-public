import { useRef, useState, useSyncExternalStore } from 'react';
import { useUiStore } from '../store';
import type { Speed } from '../store';
import { t, tp, formatMoney } from '../../i18n/ja';
import {
  exportCurrentGame,
  importGameFile,
  loadGameFromSlot,
  saveGameToSlot,
} from '../../game/loop';
import { MANUAL_SAVE_SLOTS } from '../../sim/save';
import {
  getAudioSettings,
  setAudioMuted,
  setAudioVolume,
  subscribeAudioSettings,
} from '../../render/audio';

/**
 * 上部バー（実装書 §12.2）: 資金/人口/日数 + 速度コントロール。
 * タップで直近1日の収支内訳を開閉する。
 */
const SPEEDS: ReadonlyArray<{ value: Speed; labelKey: string }> = [
  { value: 0, labelKey: 'hud.speedPause' },
  { value: 1, labelKey: 'hud.speed1x' },
  { value: 2, labelKey: 'hud.speed2x' },
  { value: 3, labelKey: 'hud.speed3x' },
];

export function TopBar() {
  const hud = useUiStore((s) => s.hud);
  const speed = useUiStore((s) => s.speed);
  const setSpeed = useUiStore((s) => s.setSpeed);
  const demandVisible = useUiStore((s) => s.demandVisible);
  const toggleDemandVisible = useUiStore((s) => s.toggleDemandVisible);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [showAudio, setShowAudio] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const audio = useSyncExternalStore(subscribeAudioSettings, getAudioSettings, getAudioSettings);

  const lastDay = hud.lastDay;
  const net = lastDay
    ? lastDay.taxR + lastDay.taxC + lastDay.taxI - lastDay.upkeepRoad - lastDay.upkeepFacility
    : 0;

  return (
    <div className="hud-topbar">
      <button
        type="button"
        className="hud-topbar-main"
        onClick={() => {
          setShowBreakdown((visible) => !visible);
          setShowSave(false);
          setShowAudio(false);
        }}
        aria-expanded={showBreakdown}
      >
        <span className="hud-stat hud-stat-money">{formatMoney(hud.money)}</span>
        <span className="hud-stat hud-stat-population">
          {hud.population.toLocaleString('ja-JP')}
        </span>
        <span className="hud-stat hud-stat-day">
          {hud.day}
          {t('hud.day')}
        </span>
      </button>

      <button
        type="button"
        className={`hud-speed-btn${showSave ? ' active' : ''}`}
        onClick={() => {
          setShowSave((visible) => !visible);
          setShowAudio(false);
          setShowBreakdown(false);
        }}
        aria-expanded={showSave}
        aria-label={t('save.button')}
      >
        {t('save.button')}
      </button>

      <button
        type="button"
        className={`hud-speed-btn${showAudio ? ' active' : ''}`}
        onClick={() => {
          setShowAudio((visible) => !visible);
          setShowSave(false);
          setShowBreakdown(false);
        }}
        aria-expanded={showAudio}
        aria-label={t('audio.button')}
      >
        {audio.muted ? t('audio.mutedButton') : t('audio.button')}
      </button>

      <div className="hud-speedgroup" role="group">
        {SPEEDS.map(({ value, labelKey }) => (
          <button
            key={value}
            type="button"
            className={`hud-speed-btn${speed === value ? ' active' : ''}`}
            onClick={() => setSpeed(value)}
            aria-pressed={speed === value}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* 需要バーの表示・非表示（`docs/m5-plan.md` §3-3）。既定は表示 */}
      <button
        type="button"
        className={`hud-demand-toggle${demandVisible ? ' active' : ''}`}
        onClick={toggleDemandVisible}
        aria-pressed={demandVisible}
        aria-label={t('hud.demandToggle')}
      >
        {t('hud.demandToggle')}
      </button>

      {showSave && (
        <div className="hud-breakdown">
          <div className="hud-breakdown-row">
            <span>{t('save.autoName')}</span>
            <button type="button" onClick={() => void loadGameFromSlot('auto')}>
              {t('save.load')}
            </button>
          </div>
          {MANUAL_SAVE_SLOTS.map((slot, index) => (
            <div className="hud-breakdown-row" key={slot}>
              <span>{tp('save.slotName', { slot: index + 1 })}</span>
              <span>
                <button type="button" onClick={() => void saveGameToSlot(slot)}>
                  {t('save.save')}
                </button>
                <button type="button" onClick={() => void loadGameFromSlot(slot)}>
                  {t('save.load')}
                </button>
              </span>
            </div>
          ))}
          <div className="hud-breakdown-row">
            <button type="button" onClick={exportCurrentGame}>
              {t('save.export')}
            </button>
            <button type="button" onClick={() => importRef.current?.click()}>
              {t('save.import')}
            </button>
            <input
              ref={importRef}
              hidden
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importGameFile(file);
                event.currentTarget.value = '';
              }}
            />
          </div>
        </div>
      )}

      {showAudio && (
        <div className="hud-breakdown">
          <div className="hud-breakdown-row">
            <label htmlFor="audio-volume">{t('audio.volume')}</label>
            <span>{tp('audio.volumeValue', { volume: Math.round(audio.volume * 100) })}</span>
          </div>
          <input
            id="audio-volume"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={audio.volume}
            onChange={(event) => setAudioVolume(Number(event.currentTarget.value))}
            aria-label={t('audio.volume')}
          />
          <button type="button" onClick={() => setAudioMuted(!audio.muted)}>
            {audio.muted ? t('audio.unmute') : t('audio.mute')}
          </button>
        </div>
      )}

      {showBreakdown && (
        <div className="hud-breakdown">
          {lastDay ? (
            <>
              <div className="hud-breakdown-row">
                <span>{t('hud.taxR')}</span>
                <span>{formatMoney(lastDay.taxR)}</span>
              </div>
              <div className="hud-breakdown-row">
                <span>{t('hud.taxC')}</span>
                <span>{formatMoney(lastDay.taxC)}</span>
              </div>
              <div className="hud-breakdown-row">
                <span>{t('hud.taxI')}</span>
                <span>{formatMoney(lastDay.taxI)}</span>
              </div>
              <div className="hud-breakdown-row">
                <span>{t('hud.upkeepRoad')}</span>
                <span>-{formatMoney(lastDay.upkeepRoad)}</span>
              </div>
              <div className="hud-breakdown-row">
                <span>{t('hud.upkeepFacility')}</span>
                <span>-{formatMoney(lastDay.upkeepFacility)}</span>
              </div>
              <div className="hud-breakdown-row hud-breakdown-net">
                <span>{t('hud.netTotal')}</span>
                <span>{formatMoney(net)}</span>
              </div>
            </>
          ) : (
            <div className="hud-breakdown-row">{t('hud.notStartedYet')}</div>
          )}
        </div>
      )}
    </div>
  );
}
