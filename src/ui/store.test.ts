import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './store';
import { OVERLAY_MODES, overlayDrawFor } from '../render/overlay';

/**
 * `docs/m5-plan.md` §3-2・§3-3 の UI 再編を、store 単体でテストする。
 *
 * このプロジェクトに React コンポーネントのレンダリングテスト基盤（Testing Library 等）は
 * 無いので、`Inspector.tsx` が useEffect でやっていた「ツールを切り替えたら選択を消す」を
 * `store.ts` 側（setTool/setZone/setRoadMode の中と、setSelection/setSelectedVehicleId の
 * 入場ガード）へ寄せてある。ここではその store の振る舞いだけを直接検証する。
 */

// zustand のストアはモジュール単位のシングルトンなので、テスト間で状態が漏れないよう
// 初期状態を1度だけ捕まえておいて、毎回まるごと置き換える。
const initialState = useUiStore.getState();

beforeEach(() => {
  useUiStore.setState(initialState, true);
});

describe('分析ツール以外ではタップ選択が入らない（§3-2 本丸）', () => {
  it('pan ツール中に setSelection を呼んでも selection は null のまま', () => {
    useUiStore.getState().setTool('pan');
    useUiStore.getState().setSelection({ x: 1, y: 2 });
    expect(useUiStore.getState().selection).toBeNull();
  });

  it('road ツール中に setSelectedVehicleId を呼んでも selectedVehicleId は null のまま', () => {
    useUiStore.getState().setTool('road');
    useUiStore.getState().setSelectedVehicleId(5);
    expect(useUiStore.getState().selectedVehicleId).toBeNull();
  });

  it('traffic ツール中も同様に入らない', () => {
    useUiStore.getState().setTool('traffic');
    useUiStore.getState().setSelection({ x: 3, y: 3 });
    expect(useUiStore.getState().selection).toBeNull();
  });

  it('分析ツール中は選択が入る（本丸のガードが誤って全ツールを塞いでいないこと）', () => {
    useUiStore.getState().setTool('analysis');
    useUiStore.getState().setSelection({ x: 3, y: 4 });
    useUiStore.getState().setSelectedVehicleId(7);
    expect(useUiStore.getState().selection).toEqual({ x: 3, y: 4 });
    expect(useUiStore.getState().selectedVehicleId).toBe(7);
  });

  it('選択解除（null）はどのツールからでも常に通る', () => {
    useUiStore.getState().setTool('analysis');
    useUiStore.getState().setSelection({ x: 1, y: 1 });
    useUiStore.getState().setTool('pan');
    // ここで既に消えているはずだが、明示的な解除呼び出しも弾かれないことを確認する
    useUiStore.getState().setSelection(null);
    useUiStore.getState().setSelectedVehicleId(null);
    expect(useUiStore.getState().selection).toBeNull();
    expect(useUiStore.getState().selectedVehicleId).toBeNull();
  });
});

describe('ツールを切り替えると選択が消える（§3-2）', () => {
  it('分析ツールから別のツールへ setTool すると、建物・車の選択が両方消える', () => {
    useUiStore.getState().setTool('analysis');
    useUiStore.getState().setSelection({ x: 3, y: 4 });
    useUiStore.getState().setSelectedVehicleId(7);
    expect(useUiStore.getState().selection).not.toBeNull();
    expect(useUiStore.getState().selectedVehicleId).toBe(7);

    useUiStore.getState().setTool('road');
    expect(useUiStore.getState().selection).toBeNull();
    expect(useUiStore.getState().selectedVehicleId).toBeNull();
  });

  it('setZone も選択を消す（分析ツールから区画ツールへ）', () => {
    useUiStore.getState().setTool('analysis');
    useUiStore.getState().setSelection({ x: 1, y: 1 });
    useUiStore.getState().setZone('commercial');
    expect(useUiStore.getState().tool).toBe('zone');
    expect(useUiStore.getState().selection).toBeNull();
  });

  it('setRoadMode も選択を消す（分析ツールから道路ツールへ）', () => {
    useUiStore.getState().setTool('analysis');
    useUiStore.getState().setSelectedVehicleId(9);
    useUiStore.getState().setRoadMode('arterial');
    expect(useUiStore.getState().tool).toBe('road');
    expect(useUiStore.getState().selectedVehicleId).toBeNull();
  });

  it('分析ツールのサブモードを切り替えるだけ（setOverlay）では選択を消さない', () => {
    useUiStore.getState().setTool('analysis');
    useUiStore.getState().setSelection({ x: 2, y: 2 });
    useUiStore.getState().setOverlay('congestion');
    expect(useUiStore.getState().tool).toBe('analysis');
    expect(useUiStore.getState().selection).toEqual({ x: 2, y: 2 });
  });
});

describe('需要バーの表示・非表示トグル（§3-3）', () => {
  it('既定は表示', () => {
    expect(useUiStore.getState().demandVisible).toBe(true);
  });

  it('トグルで消え、もう一度で戻る', () => {
    useUiStore.getState().toggleDemandVisible();
    expect(useUiStore.getState().demandVisible).toBe(false);
    useUiStore.getState().toggleDemandVisible();
    expect(useUiStore.getState().demandVisible).toBe(true);
  });
});

describe('分析カテゴリーの新モード（§3-2・§4-3・§4-4）', () => {
  it("OVERLAY_MODES に 'flow' と 'routes' が入っている", () => {
    expect(OVERLAY_MODES).toContain('flow');
    expect(OVERLAY_MODES).toContain('routes');
  });

  /**
   * サブ行に並ぶ選択肢は、必ず描く実体を持っていること。
   *
   * この2つは UI（選択肢）と描画（`overlay.ts`）を別々の担当が同時に作った箇所で、
   * 片方だけ入ると「ボタンはあるのに何も起きない」になる。**選択肢と実装の対応を
   * ここで固定する**ことで、次にモードを足す人が片側だけ入れても気付ける。
   * （`'off'` だけは「何も塗らない」が仕様なので null が正しい）
   */
  it('サブ行に出るモードは off 以外すべて描画の実体を持つ', () => {
    for (const mode of OVERLAY_MODES) {
      expect(overlayDrawFor(mode), `${mode} に描画がない`).not.toBeNull();
    }
    expect(overlayDrawFor('off')).toBeNull();
  });
});
