import { useEffect, useRef, useState } from 'react';
import { startGame, type Game } from '../game/loop';
import { t } from '../i18n/ja';
import { Hud } from './components/Hud';
import { useUiStore, type RoadMode } from './store';
import './hud.css';

/** 開発中は固定シード。M4 のタイトル画面でシード指定・新規開始を作る */
const SEED = 20260729;

/**
 * 道路ツールの巡回順（`docs/m4-trace-design.md` T7 §5）: 通常 → 幹線 → 縮小 → 通常。
 * 区画は Digit3/4/5 に1つずつ直接割り当てられるが、道路は3状態に対して
 * 数字キーが Digit2 の1つしか残っていないため、押すたびに巡回させる。
 *
 * `export` はテスト（`App.test.ts`）から直接呼ぶため。
 */
export function nextRoadMode(current: RoadMode): RoadMode {
  if (current === 'normal') return 'arterial';
  if (current === 'arterial') return 'shrink';
  return 'normal';
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let game: Game | null = null;
    let disposed = false;

    void startGame(host, SEED).then((g) => {
      if (disposed) {
        g.destroy();
        return;
      }
      game = g;
      setReady(true);
    });

    // PC 向けショートカット（実装書 §12.2）
    const onKey = (ev: KeyboardEvent) => {
      const ui = useUiStore.getState();
      if (ev.code === 'Space') {
        ev.preventDefault();
        ui.togglePause();
        return;
      }
      const map: Record<string, () => void> = {
        Digit1: () => ui.setTool('pan'),
        // 道路ツールに入っていない間は、最初の押下ではモードを進めずツール切替だけ行う
        // （直前に使っていたモードのまま入る。区画がタブを跨いでも選択色を覚えているのと
        // 揃える）。既に道路ツールにいるときだけ、押すたびに通常→幹線→縮小と進む（T7 §5）。
        Digit2: () => ui.setRoadMode(ui.tool === 'road' ? nextRoadMode(ui.roadMode) : ui.roadMode),
        Digit3: () => ui.setZone('residential'),
        Digit4: () => ui.setZone('commercial'),
        Digit5: () => ui.setZone('industrial'),
        Digit6: () => ui.setTool('demolish'),
        // 施設ツール（`docs/m6-plan.md` §2 W4）。既に選んでいた施設のまま入る
        // （区画・道路と同じ考え方。setFacilityDefId 経由の切り替えは Toolbar 側が担う）
        Digit7: () => ui.setTool('facility'),
      };
      map[ev.code]?.();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKey);
      game?.destroy();
    };
  }, []);

  return (
    <div className="app">
      <div ref={hostRef} className="stage" />
      {ready ? <Hud /> : <div className="status">{t('status.loading')}</div>}
    </div>
  );
}
