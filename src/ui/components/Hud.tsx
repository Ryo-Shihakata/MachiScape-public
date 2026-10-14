import { TopBar } from './TopBar';
import { DemandBars } from './DemandBars';
import { DistrictPurchase } from './DistrictPurchase';
import { MilestoneBar } from './MilestoneBar';
import { Toolbar } from './Toolbar';
import { Toast } from './Toast';
import { Inspector } from './Inspector';
import { useUiStore } from '../store';
import '../hud.css';

/**
 * ゲーム画面に重ねる HUD 全体（実装書 §12.2）。
 *
 * キャンバスの上のオーバーレイなので、ルートは pointer-events: none にし、
 * 実際に触る要素（ボタン等）だけ pointer-events: auto にする（hud.css）。
 * これを崩すとゲーム画面のドラッグ操作ができなくなる。
 *
 * 情報オーバーレイの切替は `Toolbar` の分析ツールのサブ行に統合済み
 * （`docs/m5-plan.md` §3-2。旧 `OverlayPicker` は廃止）。
 *
 * `MilestoneBar` は下部ツールバーの直上に置く（実装書 §12.2「マイルストーン進捗:
 * 下部ツールバー上に細いプログレスバー」）。`DistrictPurchase` はエリア購入の
 * タップに応じて自分で開閉するので、常に描画しておいて中身側で null を返させる
 * （`Inspector` と同じ形）。
 */
export function Hud() {
  // 需要バーの表示・非表示（§3-3）。既定は表示なので、今までと見え方は変わらない
  const demandVisible = useUiStore((s) => s.demandVisible);

  return (
    <div className="hud">
      <div className="hud-top-stack">
        <TopBar />
        {demandVisible && <DemandBars />}
      </div>
      <Inspector />
      <DistrictPurchase />
      <div className="hud-bottom-stack">
        <Toast />
        <MilestoneBar />
        <Toolbar />
      </div>
    </div>
  );
}
