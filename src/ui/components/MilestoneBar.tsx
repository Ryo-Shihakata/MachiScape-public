/**
 * マイルストーン進捗バー + 一覧パネル（`docs/m6-plan.md` §2 W3、実装書 §12.2）。
 *
 * 下部ツールバーの直上に細いプログレスバーを常設し、「次の目標まであと何人か」を
 * 必ず**言葉で**出す（数値だけ出して放置しない、が設計上の要点）。タップすると
 * 全マイルストーンの達成状況と解放内容の一覧が開く。
 *
 * 達成条件は人口だけ（`src/sim/progress/milestones.ts`）。品質ゲート（処理率）は
 * `docs/m6-plan.md` §1-4 の実測で取り下げ済みなので、ここでも人口以外は扱わない。
 *
 * sim 側の達成判定（`achievedMilestones` を実際に積む処理）は別の作業者が並行実装中で、
 * 今は常に空配列のまま届く。それでも「全部未達成」として矛盾なく表示できることを
 * このファイルの責務にする（sim が追いついた時点で自然にバナー・進捗が動き出す）。
 */

import { useEffect, useRef, useState } from 'react';
import { MILESTONES, nextMilestone, type MilestoneDef } from '../../sim/progress/milestones';
import { t, tp } from '../../i18n/ja';
import { useUiStore } from '../store';
import '../milestone.css';

/** 達成バナーの表示時間。UIタイミング値なので sim/balance.ts の対象外（Toast.tsx と同じ扱い） */
const BANNER_DURATION_MS = 4000;

export interface MilestoneProgress {
  /** 次の未達成マイルストーン。全部達成済みなら null */
  next: MilestoneDef | null;
  /** 次の目標まであと何人か。next が null なら 0 */
  remaining: number;
  /** 直前のマイルストーンから次までの間で、バーがどれだけ埋まっているか（0..1） */
  ratio: number;
}

/**
 * 現在の人口・達成済みマイルストーンから進捗を組み立てる純関数。
 * `export` はテスト（`MilestoneBar.test.ts`）から直接呼ぶため——
 * 「次の目標まであと何人」の文言が現在の人口から正しく作られることを、
 * React のレンダーを介さずに確認する。
 */
export function milestoneProgressFor(
  population: number,
  achieved: readonly string[],
): MilestoneProgress {
  const next = nextMilestone(achieved);
  if (!next) return { next: null, remaining: 0, ratio: 1 };
  const idx = MILESTONES.findIndex((m) => m.id === next.id);
  const prevPop = idx > 0 ? MILESTONES[idx - 1]!.pop : 0;
  const span = next.pop - prevPop;
  const ratio = span > 0 ? Math.max(0, Math.min(1, (population - prevPop) / span)) : 1;
  return { next, remaining: Math.max(0, next.pop - population), ratio };
}

/**
 * 前回と比べて新しく増えた達成済みID（達成バナー用）。
 * `export` はテスト用。順序は `achieved` の並びのまま返す。
 */
export function newlyAchieved(
  previous: readonly string[],
  current: readonly string[],
): string[] {
  return current.filter((id) => !previous.includes(id));
}

/** `unlocks` の1件ぶんの表示名。未知のIDでも落ちないよう、キーが無ければそのIDを出す */
function unlockLabel(id: string): string {
  const key = `milestone.unlock.${id}`;
  const label = t(key);
  return label === key ? id : label;
}

function MilestonePanel({ achieved }: { achieved: readonly string[] }) {
  return (
    <div className="ms-panel">
      <div className="ms-scroll">
        {MILESTONES.map((m) => {
          const done = achieved.includes(m.id);
          return (
            <div className={`ms-row${done ? ' ms-row-done' : ''}`} key={m.id}>
              <div className="ms-row-main">
                <span className="ms-row-pop">{tp('milestone.popLabel', { pop: m.pop })}</span>
                <span className={`ms-badge${done ? ' ms-badge-done' : ''}`}>
                  {done ? t('milestone.achieved') : t('milestone.notYetAchieved')}
                </span>
              </div>
              <p className="ms-unlocks">
                {m.unlocks.length > 0
                  ? `${t('milestone.unlocksLabel')}: ${m.unlocks.map(unlockLabel).join(' / ')}`
                  : t('milestone.badgeOnly')}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MilestoneBar() {
  const population = useUiStore((s) => s.hud.population);
  const achievedMilestones = useUiStore((s) => s.hud.achievedMilestones);
  const panelOpen = useUiStore((s) => s.milestonePanelOpen);
  const toggleMilestonePanel = useUiStore((s) => s.toggleMilestonePanel);

  const progress = milestoneProgressFor(population, achievedMilestones);

  // 新規達成の検知（達成バナー）。前回描画時の achievedMilestones と比較する。
  const previousRef = useRef<readonly string[]>(achievedMilestones);
  const [banner, setBanner] = useState<MilestoneDef | null>(null);
  useEffect(() => {
    const newly = newlyAchieved(previousRef.current, achievedMilestones);
    previousRef.current = achievedMilestones;
    if (newly.length === 0) return;
    const lastId = newly[newly.length - 1]!;
    const def = MILESTONES.find((m) => m.id === lastId);
    if (!def) return;
    setBanner(def);
    const timer = window.setTimeout(() => setBanner(null), BANNER_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [achievedMilestones]);

  return (
    <div className="ms-stack">
      {banner && (
        <div className="ms-banner" role="status">
          {tp('milestone.achievedBanner', {
            name: banner.unlocks.length > 0 ? banner.unlocks.map(unlockLabel).join(' / ') : t('milestone.title'),
          })}
        </div>
      )}
      <button
        type="button"
        className="ms-bar"
        aria-expanded={panelOpen}
        aria-label={t('milestone.title')}
        onClick={toggleMilestonePanel}
      >
        <span className="ms-track">
          <span className="ms-fill" style={{ width: `${progress.ratio * 100}%` }} />
        </span>
        <span className="ms-label">
          {progress.next ? tp('milestone.remaining', { n: progress.remaining }) : t('milestone.allDone')}
        </span>
      </button>
      {panelOpen && <MilestonePanel achieved={achievedMilestones} />}
    </div>
  );
}
