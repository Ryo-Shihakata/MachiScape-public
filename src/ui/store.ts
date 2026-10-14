/**
 * UI の状態（実装書 §1: Zustand は UI 状態のみ。ゲームの状態は sim が持つ）。
 *
 * ここに GameState を入れないこと。シミュは毎tick更新されるので、
 * React の再描画に載せると 10Hz で全体が再レンダリングされる。
 * ゲーム画面は Pixi が直接 GameState を読んで描き、React は HUD だけを持つ。
 */

import { create } from 'zustand';
import { FACILITY_DEFS } from '../sim/facility/defs';
import type { TilePos, ZoneType } from '../sim/types';
import type { OverlayMode } from '../render/overlay';

/** `facility` は M6 W4（`docs/m6-plan.md` §2 W4）。`FACILITY_DEFS` から作るサブ行を持つ */
export type Tool = 'pan' | 'road' | 'zone' | 'facility' | 'demolish' | 'traffic' | 'analysis';
export type Speed = 0 | 1 | 2 | 3;

/**
 * 道路ツールのサブモード（`docs/m4-trace-design.md` T7 §1）。
 * 区画の「住/商/工」と同じ位置に「通常/幹線/縮小」として出す。
 */
export type RoadMode = 'normal' | 'arterial' | 'shrink';

/**
 * 情報オーバーレイの表示モード（実装書 §12.3）。
 * **同時に有効なのは1つだけ。既定は 'off'。**
 *
 * 定義の実体は `src/render/overlay.ts` にある（描画側の関心なので）。
 * ここに定義すると render がそれを import する必要が生まれ、依存方向
 * （ui → render → sim）の逆流になって ESLint に弾かれる。
 */
export type { OverlayMode };

/**
 * ツールごとのドラッグの意味（実装書 §12.3）。
 * 道路は「開始点からの直線」（D2）、区画と撤去は矩形。
 *
 * `point` は施設ツール専用（`docs/m6-plan.md` §2 W4）。施設は1〜4タイルの
 * footprint を「置く」操作であって面を塗る操作ではないので、ドラッグ中は
 * 常に**現在の指の位置**だけを対象にする（`game/loop.ts` の `updateDrag` 参照）。
 * 押した位置に固定せず追従させることで、指を離す直前まで置き場所を調整できる。
 */
export type DragShape = 'line' | 'rect' | 'point';

/** HUD に表示するためにシミュから吸い上げた値。1秒に数回だけ更新する */
export interface HudSnapshot {
  money: number;
  population: number;
  day: number;
  demand: { residential: number; commercial: number; industrial: number };
  vehicles: number;
  /** 直近1日の収支内訳。null なら1日も終わっていない */
  lastDay: {
    taxR: number;
    taxC: number;
    taxI: number;
    upkeepRoad: number;
    upkeepFacility: number;
  } | null;
  /**
   * 達成済みマイルストーンID（`docs/m6-plan.md` §2 W3）。マイルストーン進捗バーが
   * 「次の目標まであと何人か」を出すため、また新規達成をバナーで知らせるために持つ。
   * sim 側の達成判定は別担当が並行実装中で、今は常に空配列のまま届く（それでも
   * 「未達成」として正しく表示できること——落ちないことの条件）。
   */
  achievedMilestones: readonly string[];
}

export const emptySnapshot: HudSnapshot = {
  money: 0,
  population: 0,
  day: 0,
  demand: { residential: 0, commercial: 0, industrial: 0 },
  vehicles: 0,
  lastDay: null,
  achievedMilestones: [],
};

interface UiState {
  tool: Tool;
  zone: ZoneType;
  roadMode: RoadMode;
  speed: Speed;
  /** 建設できない操作をしたときの一時メッセージ */
  toast: string | null;
  hud: HudSnapshot;
  /**
   * 分析ツールのサブ選択（実装書 §12.3、`docs/m5-plan.md` §3-2）。
   * 同時に有効なのは1つだけ。既定は 'off'（＝「なし」。塗らずにタップ選択だけ使う）。
   */
  overlay: OverlayMode;
  /** インスペクタが見ているタイル。null なら何も選択していない */
  selection: TilePos | null;
  selectedVehicleId: number | null;
  /**
   * 需要バーの表示・非表示（`docs/m5-plan.md` §3-3）。既定は表示（今の見え方を変えない）。
   * sim には持たせない（セーブに入れる情報ではなく、見た目の好みでしかないため）。
   */
  demandVisible: boolean;
  /** 施設ツールで選んでいる施設（`docs/m6-plan.md` §2 W4）。`FACILITY_DEFS` の1つの id */
  facilityDefId: string;
  /**
   * エリア購入パネル（`docs/m6-plan.md` §2 W1）の対象チャンク。null なら閉じている。
   * GameState ではなくチャンク座標だけを持つ——価格・資金・解放状況は
   * `getCurrentWorld()` から読む（`ui/components/DistrictPurchase.tsx` の規約）。
   */
  districtPurchaseTarget: { cx: number; cy: number } | null;
  /** マイルストーン一覧パネルの開閉（`docs/m6-plan.md` §2 W3） */
  milestonePanelOpen: boolean;

  setTool: (t: Tool) => void;
  setZone: (z: ZoneType) => void;
  setRoadMode: (m: RoadMode) => void;
  setSpeed: (s: Speed) => void;
  togglePause: () => void;
  showToast: (msg: string) => void;
  clearToast: () => void;
  setHud: (h: HudSnapshot) => void;
  setOverlay: (m: OverlayMode) => void;
  setSelection: (p: TilePos | null) => void;
  setSelectedVehicleId: (id: number | null) => void;
  toggleDemandVisible: () => void;
  setFacilityDefId: (id: string) => void;
  openDistrictPurchase: (cx: number, cy: number) => void;
  closeDistrictPurchase: () => void;
  toggleMilestonePanel: () => void;
}

/**
 * 分析ツール以外へ移るなら、インスペクタの選択も一緒に捨てる
 * （`docs/m5-plan.md` §3-2:「分析ツール以外ではインスペクタを開かない。
 * ツールを切り替えたら選択も消す」の実体）。
 * `setSelection` / `setSelectedVehicleId` 側の入場ガードと対になっていて、
 * こちらは「出るときに掃除する」役目を持つ。
 */
function clearSelectionUnlessAnalysis(
  tool: Tool,
): Partial<Pick<UiState, 'selection' | 'selectedVehicleId'>> {
  return tool === 'analysis' ? {} : { selection: null, selectedVehicleId: null };
}

export const useUiStore = create<UiState>((set, get) => ({
  tool: 'road',
  zone: 'residential',
  roadMode: 'normal',
  speed: 1,
  toast: null,
  hud: emptySnapshot,
  overlay: 'off',
  selection: null,
  selectedVehicleId: null,
  demandVisible: true,
  facilityDefId: FACILITY_DEFS[0]?.id ?? 'park',
  districtPurchaseTarget: null,
  milestonePanelOpen: false,

  setTool: (tool) => set({ tool, ...clearSelectionUnlessAnalysis(tool) }),
  setZone: (zone) => set({ zone, tool: 'zone', selection: null, selectedVehicleId: null }),
  // setZone がツールも 'zone' に寄せるのと同じ理由（区画/道路のサブ選択ボタンは
  // 自分のツールに切り替わっていないと出ない）。Digit2 連打での巡回もこれ1本で通す
  // （最初の押下でツールが 'road' に切り替わり、以降は roadMode だけが進む）。
  // 'zone'/'road' は分析ツールではないので選択も毎回捨てる。
  setRoadMode: (roadMode) => set({ roadMode, tool: 'road', selection: null, selectedVehicleId: null }),
  setSpeed: (speed) => set({ speed }),
  togglePause: () => set({ speed: get().speed === 0 ? 1 : 0 }),
  showToast: (toast) => set({ toast }),
  clearToast: () => set({ toast: null }),
  setHud: (hud) => set({ hud }),
  // 分析ツールのサブ選択（§3-2）。区画・道路のサブ選択（setZone/setRoadMode）と同じ形で
  // ツールも 'analysis' に寄せる。**選択は消さない**点だけがそちらと違う
  // （渋滞→満足度のようにサブモードだけ切り替えても、選んでいる建物は見続けたいため）。
  setOverlay: (overlay) => set({ overlay, tool: 'analysis' }),
  /**
   * タップでの選択は分析ツール中だけ通す（§3-2 本丸: 「開こうとしていないパネルが
   * 開く」の構造的な解）。null への変更（＝選択解除）は常にどのツールからでも通す。
   *
   * `src/game/loop.ts` の `onTap`（入力ハンドラ。W3 は触らない）は今もツール判定なしに
   * `setSelection` を呼ぶ経路が残るが、ここでガードすることで分析ツール以外では
   * 実際に選択が入らない。
   */
  setSelection: (selection) => {
    if (selection !== null && get().tool !== 'analysis') return;
    set({ selection });
  },
  setSelectedVehicleId: (selectedVehicleId) => {
    if (selectedVehicleId !== null && get().tool !== 'analysis') return;
    set({ selectedVehicleId });
  },
  toggleDemandVisible: () => set({ demandVisible: !get().demandVisible }),
  // 施設のサブ選択（`docs/m6-plan.md` §2 W4）。setZone/setRoadMode と同じ形で
  // ツールも 'facility' に寄せ、分析ツールではないので選択も毎回捨てる。
  setFacilityDefId: (facilityDefId) =>
    set({ facilityDefId, tool: 'facility', selection: null, selectedVehicleId: null }),
  openDistrictPurchase: (cx, cy) => set({ districtPurchaseTarget: { cx, cy } }),
  closeDistrictPurchase: () => set({ districtPurchaseTarget: null }),
  toggleMilestonePanel: () => set({ milestonePanelOpen: !get().milestonePanelOpen }),
}));

/**
 * ツールごとにドラッグの意味を決める（実装書 §12.3）。
 *
 * 道路だけが直線スナップ（D2 で確定）。区画と撤去は面を扱う操作なので矩形にする。
 * 施設は `point`（`DragShape` の説明を参照）。パンはドラッグがカメラ操作なので、
 * ここには来ない。
 */
export function dragShapeFor(tool: Tool): DragShape {
  if (tool === 'road') return 'line';
  if (tool === 'facility') return 'point';
  return 'rect';
}
