import { useEffect, useState } from 'react';
import { useUiStore } from '../store';
import type { RoadMode, Tool } from '../store';
import type { ZoneType } from '../../sim/types';
import { FACILITY_DEFS, type FacilityDef } from '../../sim/facility/defs';
import { MILESTONES, isUnlocked } from '../../sim/progress/milestones';
import { OVERLAY_MODES, type OverlayMode } from '../../render/overlay';
import { t, tp } from '../../i18n/ja';
import { getCurrentWorld } from '../../game/current';
import { summarizeIntersections, type IntersectionSummary } from '../../game/loop';
import '../traffic.css';
import '../facility.css';

/**
 * 下部ツールバー（実装書 §12.2、`docs/m5-plan.md` §3-1）。横スクロール可。
 * 区画ツール選択時は住・商・工のサブ選択が上に出る。
 * 「交通」ツール選択時は交差点の要約が同じ位置に出る（`docs/m4-ui-design.md` §1.4。
 * 区画のサブ行と排他なので段は増えない）。
 *
 * **撤去は隔離する**（§3-1）。破壊的な操作が建設系のボタンに紛れていると誤爆するので、
 * `TOOLS` には含めず、間に余白を挟んで別のピルに分けて右端へ描く
 * （`hud-toolbar-row` / `hud-toolbar-demolish`。`TOOLBAR_ORDER` はテストが並び順を
 * 確認するために export している）。
 */
const TOOLS: ReadonlyArray<Tool> = ['pan', 'road', 'zone', 'facility', 'traffic', 'analysis'];
const DEMOLISH_TOOL: Tool = 'demolish';
/** テスト用: 実際にユーザーが目にする左→右の並び（撤去が最後） */
export const TOOLBAR_ORDER: ReadonlyArray<Tool> = [...TOOLS, DEMOLISH_TOOL];

const ZONES: ReadonlyArray<ZoneType> = ['residential', 'commercial', 'industrial'];
/** 道路ツールのサブ選択（T7 §1）。区画の ZONES と同じ役割 */
const ROAD_MODES: ReadonlyArray<RoadMode> = ['normal', 'arterial', 'shrink'];
/**
 * 分析ツールのサブ選択（§3-2）。区画・道路のサブ行と同じ形にする。
 * 旧 `OverlayPicker` と違い「なし」（'off'）も他と同列の1ボタンにする
 * （旧: 'off' だけ右端の別ボタン。新: サブ選択の一員）。
 */
const ANALYSIS_MODES: ReadonlyArray<OverlayMode> = ['off', ...OVERLAY_MODES];

/**
 * 施設のサブ選択（`docs/m6-plan.md` §2 W4）。区画・道路・分析と同じ形にするが、
 * 中身は配列をベタ書きせず `FACILITY_DEFS`（`src/sim/facility/defs.ts`）から作る
 * ——依頼文にある「データ駆動なのが defs.ts の設計意図」を守るため。残り3種の
 * 施設が増えても、ここは1文字も変えずにボタンが増える。
 */
const FACILITIES: readonly FacilityDef[] = FACILITY_DEFS;

/**
 * 施設が今解放されているか。`unlock: 'start'` は常に解放済み、それ以外は
 * `isUnlocked`（`sim/progress/milestones.ts`）に judge を委ねる（UI側で条件を書き直さない）。
 * `export` はテスト（`Toolbar.test.ts`）から直接呼ぶため。
 */
export function isFacilityUnlocked(def: FacilityDef, achieved: readonly string[]): boolean {
  return def.unlock === 'start' || isUnlocked(achieved, def.id);
}

/**
 * 未解放の施設が「何をすれば解放されるか」を出すための必要人口。
 * 対応するマイルストーンが見つからない（＝'start' で常に解放済み）場合は null。
 * `export` はテスト（`Toolbar.test.ts`）から直接呼ぶため。
 */
export function facilityUnlockPop(def: FacilityDef): number | null {
  if (def.unlock === 'start') return null;
  return MILESTONES.find((m) => m.unlocks.includes(def.id))?.pop ?? null;
}

/** 交差点の要約を読み直す間隔。`src/game/current.ts` の規約（毎フレーム読まない） */
const SUMMARY_REFRESH_MS = 250;

const emptySummary: IntersectionSummary = { total: 0, controlled: 0 };

/**
 * 「交通」ツール選択中だけ交差点の要約を数え直す。`summarizeIntersections` は
 * グリッド全体を舐めるので、`active` が false の間はタイマーごと持たない
 * （通常プレイ中の負荷はゼロ。`Inspector` の 250ms ポーリングと同じ考え方）。
 */
function useIntersectionSummary(active: boolean): IntersectionSummary {
  const [summary, setSummary] = useState<IntersectionSummary>(emptySummary);
  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      const world = getCurrentWorld();
      if (world) setSummary(summarizeIntersections(world));
    };
    refresh();
    const id = setInterval(refresh, SUMMARY_REFRESH_MS);
    return () => clearInterval(id);
  }, [active]);
  return summary;
}

export function Toolbar() {
  const tool = useUiStore((s) => s.tool);
  const zone = useUiStore((s) => s.zone);
  const roadMode = useUiStore((s) => s.roadMode);
  const overlay = useUiStore((s) => s.overlay);
  const facilityDefId = useUiStore((s) => s.facilityDefId);
  const achievedMilestones = useUiStore((s) => s.hud.achievedMilestones);
  const setTool = useUiStore((s) => s.setTool);
  const setZone = useUiStore((s) => s.setZone);
  const setRoadMode = useUiStore((s) => s.setRoadMode);
  const setOverlay = useUiStore((s) => s.setOverlay);
  const setFacilityDefId = useUiStore((s) => s.setFacilityDefId);
  const showToast = useUiStore((s) => s.showToast);
  const trafficSummary = useIntersectionSummary(tool === 'traffic');
  const selectedFacility = FACILITIES.find((f) => f.id === facilityDefId) ?? FACILITIES[0];

  return (
    <div className="hud-toolbar">
      {tool === 'road' && (
        <div className="hud-road-row" role="group">
          {ROAD_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`hud-road-btn${roadMode === m ? ' active' : ''}`}
              onClick={() => setRoadMode(m)}
              aria-pressed={roadMode === m}
            >
              {t(`road.${m}`)}
            </button>
          ))}
        </div>
      )}
      {tool === 'zone' && (
        <div className="hud-zone-row" role="group">
          {ZONES.map((z) => (
            <button
              key={z}
              type="button"
              className={`hud-zone-btn hud-zone-${z}${zone === z ? ' active' : ''}`}
              onClick={() => setZone(z)}
              aria-pressed={zone === z}
            >
              {t(`zone.${z}`)}
            </button>
          ))}
        </div>
      )}
      {tool === 'facility' && (
        <>
          {/* 選んでいる施設の説明。「公園=負荷なし／学校=通学の車が増える」の対比を
              数字ではなく文章で明示する（`docs/m6-plan.md` §2 W4） */}
          {selectedFacility && (
            <div className="hud-facility-hint">
              {t(`facility.${selectedFacility.id}.description`)}
              {' '}
              {selectedFacility.extraTripRate > 0 ? t('facility.extraTrip') : t('facility.noExtraTrip')}
            </div>
          )}
          <div className="hud-facility-row" role="group" aria-label={t('facility.title')}>
            {FACILITIES.map((def) => {
              const unlocked = isFacilityUnlocked(def, achievedMilestones);
              return (
                <button
                  key={def.id}
                  type="button"
                  className={`hud-facility-btn${facilityDefId === def.id ? ' active' : ''}${unlocked ? '' : ' locked'}`}
                  aria-pressed={facilityDefId === def.id}
                  aria-disabled={!unlocked}
                  onClick={() => {
                    if (!unlocked) {
                      const pop = facilityUnlockPop(def);
                      showToast(pop === null ? t('facility.locked') : tp('facility.unlockRequirement', { pop }));
                      return;
                    }
                    setFacilityDefId(def.id);
                  }}
                >
                  {t(`facility.${def.id}.name`)}
                  {!unlocked && <span className="hud-facility-lock">🔒</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
      {tool === 'traffic' && (
        <div className="hud-traffic-row" role="status">
          {tp('traffic.summary', {
            total: trafficSummary.total,
            controlled: trafficSummary.controlled,
          })}
        </div>
      )}
      {tool === 'analysis' && (
        <>
          {/* 選んでいる間だけ、色の意味を1行で出す（旧 OverlayPicker と同じ考え方） */}
          {overlay !== 'off' && <div className="hud-overlay-hint">{t(`overlay.hint.${overlay}`)}</div>}
          <div className="hud-analysis-row" role="group" aria-label={t('overlay.title')}>
            {ANALYSIS_MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={`hud-analysis-btn${overlay === m ? ' active' : ''}`}
                onClick={() => setOverlay(m)}
                aria-pressed={overlay === m}
              >
                {t(`overlay.${m}`)}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="hud-toolbar-row">
        <div className="hud-toolbar-inner" role="group">
          {TOOLS.map((tl) => (
            <button
              key={tl}
              type="button"
              className={`hud-tool-btn${tool === tl ? ' active' : ''}`}
              onClick={() => setTool(tl)}
              aria-pressed={tool === tl}
            >
              {t(`tool.${tl}`)}
            </button>
          ))}
        </div>
        {/* 撤去は間に余白を挟んだ別ピル（§3-1）。指が滑って隣を押す事故を減らす */}
        <div className="hud-toolbar-demolish" role="group">
          <button
            type="button"
            className={`hud-tool-btn${tool === DEMOLISH_TOOL ? ' active' : ''}`}
            onClick={() => setTool(DEMOLISH_TOOL)}
            aria-pressed={tool === DEMOLISH_TOOL}
          >
            {t(`tool.${DEMOLISH_TOOL}`)}
          </button>
        </div>
      </div>
    </div>
  );
}
