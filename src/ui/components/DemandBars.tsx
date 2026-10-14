/**
 * RCI 需要バー（実装書 §12.2）と、その内訳の説明（`docs/m3-plan.md` §4 の 3-3）。
 *
 * バーをタップすると「この需要が何で決まっているか」を**式ではなく言葉で**出す。
 * 内訳は必ず `explainDemand`（`src/sim/growth`）から取る。UI 側で数式を再実装すると
 * balance.ts の一元管理が崩れ、後のバランス調整で表示と実挙動がずれる。
 *
 * 既定は閉じている（情報を足すほど画面はうるさくなるので「既定で静か」を優先する）。
 */

import { useEffect, useMemo, useState } from 'react';
import { DEMAND, MOVE_IN } from '../../sim/balance';
import { explainDemand } from '../../sim/growth';
import type { DemandExplanation, ZoneDemandExplanation } from '../../sim/growth';
import type { ZoneType } from '../../sim/types';
import { getCurrentWorld } from '../../game/current';
import { t, tp } from '../../i18n/ja';
import { useUiStore } from '../store';
import '../inspector.css';

/** 内訳を読み直す間隔。`src/game/current.ts` の規約（毎フレーム読まない） */
const REFRESH_MS = 250;

const ROWS: ReadonlyArray<{ key: ZoneType; cls: string }> = [
  { key: 'residential', cls: 'residential' },
  { key: 'commercial', cls: 'commercial' },
  { key: 'industrial', cls: 'industrial' },
];

/**
 * 効き方の段階（`explainDemand` が返す -2..2）を記号に写すだけ。
 * **ここで閾値を判断しない**（閾値は balance.ts の EXPLAIN にあり、sim が段階に落とす）。
 */
const LEVEL_GLYPH: Record<number, string> = {
  [-2]: '−−',
  [-1]: '−',
  [0]: '±0',
  [1]: '＋',
  [2]: '＋＋',
};

function toneOf(level: number): string {
  if (level > 0) return 'up';
  if (level < 0) return 'down';
  return 'flat';
}

function signed(n: number): string {
  const v = Math.round(n * 10) / 10;
  return v > 0 ? `+${v}` : `${v}`;
}

/** 内訳の一文。つり合いの項だけは向きで文が変わる */
function noteFor(ckey: string, value: number): string {
  if (ckey === 'rJobBalance') {
    return value >= 0
      ? t('demand.contribution.rJobBalanceUp')
      : t('demand.contribution.rJobBalanceDown');
  }
  return t(`demand.contribution.${ckey}Link`);
}

/**
 * 内訳1項目。「働き口と住民のつり合い: ＋」のように**記号で強さ**を出し、
 * その下の一文で**何をすれば動くか**を言葉で見せる。
 */
function ContributionRow({
  ckey,
  value,
  level,
}: {
  ckey: string;
  value: number;
  level: number;
}) {
  return (
    <div className="ins-row">
      <div className="ins-row-main">
        <span className="ins-row-label">{t(`demand.contribution.${ckey}`)}</span>
        <span className={`ins-delta ins-${toneOf(level)}`}>
          <span className="dem-glyph">{LEVEL_GLYPH[level]}</span>
          <span className="dem-num">{signed(value)}</span>
        </span>
      </div>
      <p className="ins-link">{noteFor(ckey, value)}</p>
    </div>
  );
}

function ZoneExplain({ zone, ex }: { zone: ZoneType; ex: ZoneDemandExplanation }) {
  return (
    <section className="ins-section">
      <div className="ins-row-main">
        <span className={`dem-zone-name hud-demand-${zone}`}>{t(`zone.${zone}`)}</span>
        <span className="ins-metric">{Math.round(ex.value)}</span>
      </div>
      <p className="ins-link">{t('demand.range')}</p>
      {ex.clamped ? <p className="ins-warn">{t('demand.clamped')}</p> : null}
      {ex.contributions.map((c) => (
        <ContributionRow key={c.key} ckey={c.key} value={c.value} level={c.level} />
      ))}
      <div className="ins-row">
        <div className="ins-row-main">
          <span className="ins-row-label">{t('demand.total')}</span>
          <span className="ins-metric">{Math.round(ex.value)}</span>
        </div>
        <p className="ins-link">{tp('demand.moveInLink', { per: MOVE_IN.DEMAND_PER_MOVE_IN })}</p>
      </div>
    </section>
  );
}

function Facts({ ex }: { ex: DemandExplanation }) {
  return (
    <section className="ins-section">
      <h4 className="ins-heading">{t('demand.factsTitle')}</h4>
      <div className="ins-row-main">
        <span className="ins-row-label">{t('demand.jobs')}</span>
        <span className="ins-row-value">{Math.round(ex.jobs)}</span>
      </div>
      <div className="ins-row-main">
        <span className="ins-row-label">{t('demand.workers')}</span>
        <span className="ins-row-value">{Math.round(ex.workers)}</span>
      </div>
      <div className="ins-row-main">
        <span className="ins-row-label">{t('demand.population')}</span>
        <span className="ins-row-value">{Math.round(ex.population)}</span>
      </div>
      <div className="ins-row-main">
        <span className="ins-row-label">{t('demand.failRate')}</span>
        <span className="ins-row-value">{Math.round(ex.failRate * 100)}%</span>
      </div>
      <p className="ins-link">{t('demand.factsLink')}</p>
    </section>
  );
}

export function DemandBars() {
  const demand = useUiStore((s) => s.hud.demand);
  /** 内訳を開いている区画。null なら閉じている */
  const [open, setOpen] = useState<ZoneType | null>(null);

  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (open === null) return;
    const id = setInterval(() => setPulse((v) => v + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [open]);

  const ex = useMemo(() => {
    if (open === null) return null;
    const world = getCurrentWorld();
    return world ? explainDemand(world.state) : null;
    // pulse は「読み直すきっかけ」。値そのものは使わない
  }, [open, pulse]);

  return (
    <div className="dem-stack">
      <div className="hud-demand">
        {ROWS.map(({ key, cls }) => {
          const value = demand[key];
          const clamped = Math.max(DEMAND.MIN, Math.min(DEMAND.MAX, value));
          const half = Math.abs(clamped) / 2;
          const isNeg = clamped < 0;
          return (
            <button
              type="button"
              className={`hud-demand-row dem-row${open === key ? ' dem-row-open' : ''}`}
              key={key}
              aria-expanded={open === key}
              onClick={() => setOpen(open === key ? null : key)}
            >
              <span className="hud-demand-label">{t(`zone.${key}`)}</span>
              <span className="hud-demand-track">
                <span
                  className={`hud-demand-fill hud-demand-${cls}`}
                  style={{
                    width: `${half}%`,
                    left: isNeg ? `${50 - half}%` : '50%',
                  }}
                />
              </span>
              <span className="hud-demand-value">{Math.round(clamped)}</span>
            </button>
          );
        })}
        <p className="dem-hint">{t('demand.hint')}</p>
      </div>

      {open !== null && ex !== null ? (
        <div className="dem-panel">
          <div className="dem-scroll">
            <ZoneExplain zone={open} ex={ex[open]} />
            <Facts ex={ex} />
          </div>
          {/* 閉じるはスクロールの外に出す。中に入れると下までスクロールしないと届かない */}
          <div className="dem-foot">
            <button type="button" className="dem-close" onClick={() => setOpen(null)}>
              {t('demand.close')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
