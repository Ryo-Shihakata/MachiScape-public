/**
 * ゲームループと入力（実装書 §2.1・§12.3）。
 *
 * シミュは固定タイムステップ（10 tick/秒）で回し、描画は rAF で走らせる。
 * 倍速は「1フレームで消化する tick 数」を変えるだけで、dt は変えない
 * （dt を変えると同じ操作でも結果が変わり、決定論が壊れる）。
 *
 * 操作は D2/D3 で確定した Mini Motorways 風:
 * 開始タイルから現在位置までの直線を常に描き、指を離した瞬間に確定する。
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { INPUT, SPACE, TIME } from '../sim/balance';
import { facilityDef } from '../sim/facility/defs';
import { buildingIdAt } from '../sim/grid';
import { createCongestionMap } from '../sim/road/congestion';
import { createFlowMap, passCountsFromViews, updateFlow, type FlowMap } from '../sim/road/flow';
import { orthogonalIntersectionAt, type IntersectionDirections } from '../sim/road/intersection';
import { intersectionSignalAt, vehicleViews } from '../sim/traffic';
import type { VehicleView } from '../sim/traffic';
import {
  tileKey,
  type BuildOp,
  type GameState,
  type IntersectionAxis,
  type TilePos,
} from '../sim/types';
import {
  advance,
  applyOp,
  createWorld,
  currentDemand,
  currentStats,
  day,
  previewBuildRoad,
  previewDemolishArea,
  previewDowngradeRoad,
  previewPaintZone,
  previewUpgradeRoad,
} from '../sim/world';
import type { World } from '../sim/world';
import {
  createSaveGame,
  loadSaveGame,
  SAVE_SCHEMA_VERSION,
  stringifySaveGame,
  type SaveGame,
  type SaveSlot,
} from '../sim/save';
import { playSound, unlockAudio } from '../render/audio';
import { attachPanZoom, createCamera, worldToTile, type Camera, type Vec2 } from '../render/camera';
import {
  createGameScene,
  facilityFootprintTiles,
  facilityPlacementValid,
  facilityRadiusBounds,
  listBuyableChunks,
  type FacilityPreview,
  type IntersectionMarker,
  type PreviewTile,
} from '../render/gameScene';
import { overlayDrawFor } from '../render/overlay';
import { currentTheme } from '../render/theme';
import { t, tp } from '../i18n/ja';
import { dragShapeFor, useUiStore, type HudSnapshot } from '../ui/store';
import { clearCurrentWorld, setCurrentWorld } from './current';
import { clearBuyDistrictAction, setBuyDistrictAction } from './actions';

const MS_PER_TICK = 1000 / TIME.TICKS_PER_SECOND;
/** 1フレームで消化する tick の上限。タブ復帰時に何万tickも一気に回さないため */
const MAX_TICKS_PER_FRAME = 12;
/**
 * ポインタを押したまま動かさずにいる時間。これを超えると削除モードに入る（実装書 §12.4 W1-4）。
 * ゲームバランスの数値ではなく入力デバイスのUX調整値なので、`sim/balance.ts` ではなくここに置く
 * （`MAX_TICKS_PER_FRAME` / `HUD_INTERVAL_MS` と同じ扱い）。
 */
const LONG_PRESS_MS = 400;
/** HUD の更新間隔。毎フレーム React を再描画しない */
const HUD_INTERVAL_MS = 250;

interface SaveDatabase extends DBSchema {
  saves: {
    key: SaveSlot;
    value: SaveGame;
  };
}

interface SaveControls {
  save(slot: SaveSlot): Promise<void>;
  load(slot: SaveSlot): Promise<void>;
  exportJson(): void;
  importJson(file: File): Promise<void>;
}

let saveDatabase: Promise<IDBPDatabase<SaveDatabase>> | null = null;
let activeSaveControls: SaveControls | null = null;
let activeSaveWorld: World | null = null;

function database(): Promise<IDBPDatabase<SaveDatabase>> {
  if (saveDatabase) return saveDatabase;
  const opening = openDB<SaveDatabase>('machiscape', SAVE_SCHEMA_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('saves')) db.createObjectStore('saves');
    },
  });
  saveDatabase = opening;
  // 一時的な拒否を永続キャッシュすると、そのタブでは二度と保存を再試行できなくなる。
  void opening.catch(() => {
    if (saveDatabase === opening) saveDatabase = null;
  });
  return opening;
}

/** TopBar から実行中のゲームだけへ保存操作を渡す。 */
export async function saveGameToSlot(slot: SaveSlot): Promise<void> {
  await activeSaveControls?.save(slot);
}

export async function loadGameFromSlot(slot: SaveSlot): Promise<void> {
  await activeSaveControls?.load(slot);
}

export function exportCurrentGame(): void {
  activeSaveControls?.exportJson();
}

export async function importGameFile(file: File): Promise<void> {
  await activeSaveControls?.importJson(file);
}

/**
 * tick境界の補間で「直進中」とみなす角度の許容誤差（dot積のしきい値）。
 *
 * 道路は8方向接続なので、実際の曲がり角は必ず45度以上変わる（`Math.cos`しきい値で
 * 言うと 0.707 以下）。0.999 はその十分下にあるので、浮動小数の誤差で直進中に
 * フィレット分岐へ迷い込むことはない。
 */
const CORNER_DOT_THRESHOLD = 0.999;
/**
 * 前フレームと現フレームの位置差がこれ以上（タイル単位）離れていたら補間しない。
 *
 * 動的迂回で経路が差し替わった、複数tickが1フレームに詰め込まれた（倍速・タブ復帰）等で
 * 位置が飛ぶケース。無理に補間すると瞬間移動やワープした軌跡になる。
 */
const MAX_INTERP_DISTANCE = 1;
const MAX_INTERP_DISTANCE_SQ = MAX_INTERP_DISTANCE * MAX_INTERP_DISTANCE;

export interface Game {
  world: World;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// 交通整理（優先道路）のUI（`docs/m4-ui-design.md` §1）
//
// sim 側（`src/sim/road/intersection.ts` / `src/sim/world.ts`）に検証・状態は
// すべて実装済み。ここでは「sim の状態から見せ方を組み立てる」「タップを
// setIntersectionPriority に変換する」だけをやる。
// ---------------------------------------------------------------------------

/**
 * 交通整理ツールの巡回順（設計書 §1.2）: 指定なし → 東西 → 南北 → 指定なし。
 * ダイアログを出さず、タップのたびにこの順で切り替える。誤操作はもう一度
 * タップすれば次の状態に進んで戻ってくる。
 *
 * `export` はテスト（`loop.test.ts`）から直接呼ぶため。
 */
export function nextIntersectionAxis(current: IntersectionAxis | null): IntersectionAxis | null {
  if (current === null) return 'horizontal';
  if (current === 'horizontal') return 'vertical';
  return null;
}

/** 交差点1件ぶんの情報（座標＋優先軸＋道路のある向き）。マーカー生成とサマリ集計が共有する */
interface IntersectionInfo {
  pos: TilePos;
  axis: IntersectionAxis | null;
  /** 停止線をどの向きに描くか（M5 §4-1）。`orthogonalIntersectionAt` からそのまま運ぶ */
  directions: IntersectionDirections;
}

/**
 * 解放済みチャンクにある対象交差点（`orthogonalIntersectionAt` が成立する形状）を
 * すべて列挙する（設計書 §1.3）。`listRoadTiles`（`sim/world.ts`）と同じ走査方針。
 *
 * グリッド全体を舐めるので、呼び出し側は「交通」ツール選択中・間隔を空けて呼ぶなど、
 * 頻度を絞ること（毎フレーム呼ばない）。
 */
function listIntersections(world: World): IntersectionInfo[] {
  const { state } = world;
  const priorities = state.intersectionPriorities ?? {};
  const out: IntersectionInfo[] = [];
  for (const d of state.districts) {
    for (let ly = 0; ly < SPACE.CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < SPACE.CHUNK_SIZE; lx++) {
        const x = d.cx * SPACE.CHUNK_SIZE + lx;
        const y = d.cy * SPACE.CHUNK_SIZE + ly;
        const intersection = orthogonalIntersectionAt(state.grid, x, y);
        if (!intersection) continue;
        out.push({
          pos: { x, y },
          axis: priorities[tileKey(x, y)] ?? null,
          directions: intersection.directions,
        });
      }
    }
  }
  return out;
}

/**
 * 交差点マーカー配列を作る（設計書 §1.3 B・C）。
 *
 * 現示は交通ツール外でも常時見せるため、全対象交差点を渡す。
 * 呼び出し側は道路形状が変わらない間 `intersections` をキャッシュし、tick ごとの更新で
 * グリッド全走査を繰り返さない。
 */
function buildIntersectionMarkers(
  world: World,
  trafficToolActive: boolean,
  intersections: readonly IntersectionInfo[],
): IntersectionMarker[] {
  return intersections.map((intersection) => ({
    pos: intersection.pos,
    axis: intersection.axis,
    highlighted: trafficToolActive,
    signal: intersectionSignalAt(world.state, intersection.pos),
    directions: intersection.directions,
  }));
}

export interface IntersectionSummary {
  total: number;
  controlled: number;
}

/**
 * 「交通」ツールのサブ行（設計書 §1.4）の要約。`Toolbar` が `getCurrentWorld()` と
 * 組み合わせて呼ぶ。`listIntersections` と同じくグリッド全体を舐めるので、
 * 「交通」ツール選択中だけ・間隔を空けて呼ぶこと。
 */
export function summarizeIntersections(world: World): IntersectionSummary {
  const list = listIntersections(world);
  return { total: list.length, controlled: list.filter((i) => i.axis !== null).length };
}

/** 巡回後の軸を表す文言キー（`traffic.axis*`）。トーストの組み立てに使う */
function axisLabelKey(axis: IntersectionAxis | null): string {
  if (axis === 'horizontal') return 'traffic.axisHorizontal';
  if (axis === 'vertical') return 'traffic.axisVertical';
  return 'traffic.axisNone';
}

// ---------------------------------------------------------------------------
// エリア購入のUI（`docs/m6-plan.md` §2 W1）
//
// `districtPrice` / `buyDistrict` op は sim 側に実装済み（`src/sim/world.ts`）。
// ここでは「買える土地はどこか」をタップ判定に変換し、実際の購入は
// `game/actions.ts` 経由でコンポーネント（`DistrictPurchase.tsx`）にも開放する。
// ---------------------------------------------------------------------------

/** タイル座標が属するチャンク座標 */
function toChunkCoords(pos: TilePos): { cx: number; cy: number } {
  return {
    cx: Math.floor(pos.x / SPACE.CHUNK_SIZE),
    cy: Math.floor(pos.y / SPACE.CHUNK_SIZE),
  };
}

/**
 * タップ位置が「買える土地」（解放済みに隣接する未購入チャンク）に乗っているなら、
 * そのチャンク座標を返す。乗っていない・既に持っている場合は null。
 */
function buyableChunkAt(world: World, pos: TilePos): { cx: number; cy: number } | null {
  const { cx, cy } = toChunkCoords(pos);
  return listBuyableChunks(world.state.districts).find((c) => c.cx === cx && c.cy === cy) ?? null;
}

// ---------------------------------------------------------------------------
// 施設ツールのUI（`docs/m6-plan.md` §2 W4）
//
// `FACILITY_DEFS` はデータ駆動（`src/sim/facility/defs.ts`）。ここでは選択中の
// 施設定義から設置プレビュー（footprint の色＋効果範囲の枠）を組み立てるだけで、
// 施設の一覧そのものは `Toolbar.tsx` が `FACILITY_DEFS` を直接見て作る。
// ---------------------------------------------------------------------------

/**
 * 選択中の施設・タイル位置から `GameScene.setFacilityPreview` へ渡す形を作る。
 * 定義が見つからない（未知の defId）場合は null にして、呼び出し側が消灯できるようにする。
 */
function facilityPreviewFor(world: World, defId: string, pos: TilePos): FacilityPreview | null {
  const def = facilityDef(defId);
  if (!def) return null;
  const valid = facilityPlacementValid(world.state, def, pos);
  const footprint: PreviewTile[] = facilityFootprintTiles(pos, def.footprint).map((t) => ({
    x: t.x,
    y: t.y,
    valid,
  }));
  return { footprint, bounds: facilityRadiusBounds(pos, def.footprint, def.radius) };
}

export async function startGame(host: HTMLElement, seed: number): Promise<Game> {
  const theme = currentTheme();
  const world = createWorld(seed);

  // インスペクタ等が「任意の一点の詳細」を読めるようにする（src/game/current.ts の説明を参照）。
  //
  // **`await` より前に登録すること。** StrictMode で startGame が2回呼ばれると、
  // await の後に登録する書き方では「2回目が先に解決 → 1回目が後から自分の world を登録
  // → 1回目の destroy が current を null にする」という順序が起きる
  // （clearCurrentWorld の一致判定だけでは防げない。current が「後から来た古い world」に
  // なっているため一致してしまう）。
  // 登録を同期的に行えば、登録順は呼び出し順と必ず一致し、生きている方が最後に残る。
  setCurrentWorld(world);
  // StrictMode で古い startGame が後から解決しても、保存操作の接続先を奪わせない。
  activeSaveWorld = world;
  activeSaveControls = null;

  const scene = await createGameScene(host, theme);

  // 開始チャンクの中央から見せる
  const cam: Camera = createCamera(SPACE.CHUNK_SIZE / 2, SPACE.CHUNK_SIZE / 2, 1);
  // 初期ズームは最初の描画時に画面サイズから決める。
  // host の clientWidth/Height はレイアウト確定前だと 0 のことがあり、
  // それで計算するとマップが画面の一部にしか映らない
  let zoomFitted = false;

  let dragStart: TilePos | null = null;
  let dragTiles: TilePos[] = [];
  let accumulator = 0;
  let lastFrame = performance.now();
  let lastHud = 0;
  /**
   * **前tick**の VehicleView（id引き）。tick境界の補間の起点（実装書 §2.1）。
   * 毎フレームではなく **tick を進めたときだけ** 更新する。
   * Map 自体は使い回す（最大1,500台ぶん毎フレーム `new Map` すると無駄）。
   */
  const prevTickViews = new Map<number, VehicleView>();
  /** 現tickの VehicleView。tick を進めたときだけ作り直す */
  let currTickViews: VehicleView[] = vehicleViews(world.state);
  /** 道路編集時だけ再走査し、現示更新時はこの座標一覧を使い回す。 */
  let cachedIntersections: IntersectionInfo[] = [];
  /**
   * 流量オーバーレイ（M5 §4-3）の元データ。`World` には持たせていないので（`OverlayContext`
   * のコメント参照）、このループが所有して `scene.render` へ毎フレーム渡す。
   */
  const flow: FlowMap = createFlowMap();

  const ui = () => useUiStore.getState();

  let knownFacilityIds = new Set(world.state.facilities.map((facility) => facility.id));
  let knownMilestoneIds = new Set(world.state.progress.achievedMilestones);

  /** sim の前後差だけを購読し、音の都合を GameState に持ち込まない。 */
  function emitStateSounds(): void {
    if (world.state.facilities.some((facility) => !knownFacilityIds.has(facility.id))) {
      playSound('facility');
    }
    if (world.state.progress.achievedMilestones.some((id) => !knownMilestoneIds.has(id))) {
      playSound('milestone');
    }
    knownFacilityIds = new Set(world.state.facilities.map((facility) => facility.id));
    knownMilestoneIds = new Set(world.state.progress.achievedMilestones);
  }

  function resetStateSounds(): void {
    knownFacilityIds = new Set(world.state.facilities.map((facility) => facility.id));
    knownMilestoneIds = new Set(world.state.progress.achievedMilestones);
  }

  function saveName(slot: SaveSlot): string {
    if (slot === 'auto') return t('save.autoName');
    return tp('save.slotName', { slot: Number(slot.slice(-1)) });
  }

  async function persist(slot: SaveSlot, announce: boolean): Promise<void> {
    try {
      const save = createSaveGame(world.state, new Date().toISOString(), saveName(slot));
      const db = await database();
      await db.put('saves', save, slot);
      if (announce) ui().showToast(t('save.saved'));
    } catch {
      ui().showToast(t('save.storageFailed'));
      playSound('error');
    }
  }

  function installLoadedState(state: GameState): void {
    world.state = state;
    // rng オブジェクトだけ古いままだと、次tickでロード前の乱数列へ戻ってしまう。
    world.rng = { state: state.rngState };
    // 車両を捨てて再開するため、車両由来の混雑 EMA も同時に空へ戻す。
    world.congestion = createCongestionMap();
    accumulator = 0;
    prevTickViews.clear();
    currTickViews = vehicleViews(state);
    for (const key of Object.keys(flow)) delete flow[key];
    resetStateSounds();
    ui().setSelection(null);
    ui().setSelectedVehicleId(null);
    scene.setTraceSelection(null);
    scene.markDirty();
    refreshIntersectionMarkers();
    pushHud();
  }

  function reportLoadFailure(error: ReturnType<typeof loadSaveGame> & { ok: false }): void {
    ui().showToast(
      error.error === 'unsupported-version' ? t('save.unsupportedVersion') : t('save.loadFailed'),
    );
    playSound('error');
  }

  const controls: SaveControls = {
    async save(slot) {
      await persist(slot, true);
    },
    async load(slot) {
      try {
        const db = await database();
        const stored = await db.get('saves', slot);
        if (!stored) {
          ui().showToast(t('save.emptySlot'));
          playSound('error');
          return;
        }
        const result = loadSaveGame(stored);
        if (!result.ok) {
          reportLoadFailure(result);
          return;
        }
        installLoadedState(result.save.state);
        ui().showToast(t('save.loaded'));
      } catch {
        ui().showToast(t('save.loadFailed'));
        playSound('error');
      }
    },
    exportJson() {
      try {
        const save = createSaveGame(world.state, new Date().toISOString(), t('save.exportName'));
        const blob = new Blob([stringifySaveGame(save)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `machiscape-${save.savedAt.replace(/[:.]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(url);
        ui().showToast(t('save.exported'));
      } catch {
        ui().showToast(t('save.exportFailed'));
        playSound('error');
      }
    },
    async importJson(file) {
      try {
        const result = loadSaveGame(await file.text());
        if (!result.ok) {
          reportLoadFailure(result);
          return;
        }
        installLoadedState(result.save.state);
        ui().showToast(t('save.imported'));
      } catch {
        ui().showToast(t('save.loadFailed'));
        playSound('error');
      }
    },
  };
  if (activeSaveWorld === world) activeSaveControls = controls;

  /** 長押し中だけ選択ツールを上書きする削除モード（実装書 §12.4 W1-4）。 */
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressActive = false;
  let longPressDownAt: Vec2 | null = null;

  function clearLongPressTimer(): void {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressDownAt = null;
  }

  /** 押下位置で静止したまま `LONG_PRESS_MS` 経ったら、選択ツールに関係なく削除へ入る */
  function armLongPress(w: Vec2, screen: Vec2): void {
    clearLongPressTimer();
    longPressActive = false;
    if (ui().tool === 'demolish') return;
    const at = worldToTile(w);
    longPressDownAt = screen;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      dragStart = at;
      longPressActive = true;
      updateDrag(at); // 削除モードに切り替わったことをプレビュー色へ即反映する
    }, LONG_PRESS_MS);
  }

  /** OSキャンセルやピンチ移行では、未確定の範囲を sim に渡さず表示だけ破棄する。 */
  function cancelDrag(): void {
    dragStart = null;
    dragTiles = [];
    longPressActive = false;
    clearLongPressTimer();
    scene.setPreview([]);
    scene.setFacilityPreview(null);
  }

  /**
   * ドラッグ範囲を引き直す。
   *
   * 道路は「開始タイルから現在位置までの直線」（D2）。指の軌跡は覚えないので、
   * 行き過ぎても戻せば線も戻る。区画・撤去は面を扱う操作なので矩形になる（実装書 §12.3）。
   * 長押し削除モード中（W1-4）は選択中ツールに関係なく矩形の撤去になる。
   *
   * 施設ツール（`point`）だけは道路・区画とプレビューの土台が違う。footprint と
   * 効果範囲の枠は `scene.setFacilityPreview` の専用レイヤに任せ、`scene.setPreview`
   * 側は空にしておく（`docs/m6-plan.md` §2 W4）。
   */
  function updateDrag(to: TilePos): void {
    if (!dragStart) return;
    const shape = longPressActive ? 'rect' : dragShapeFor(ui().tool);
    dragTiles =
      shape === 'point'
        ? [to]
        : shape === 'rect'
          ? rectTiles(dragStart, to)
          : bresenham(dragStart, snapToStraight(dragStart, to));
    if (shape === 'point') {
      scene.setPreview([]);
      scene.setFacilityPreview(facilityPreviewFor(world, ui().facilityDefId, to));
      return;
    }
    scene.setFacilityPreview(null);
    scene.setPreview(previewOf(dragTiles));
  }

  /**
   * プレビューの可否判定。
   *
   * 3ツールとも `sim/world.ts` の専用関数（`previewBuildRoad` / `previewPaintZone` /
   * `previewDemolishArea`）に委ねる。矩形ドラッグは最大 32×32 = 1024 タイルになり、
   * `canApplyOp` をタイルごとに呼ぶと `pointermove` のたびに BuildOp を1024個
   * 使い捨てで作ることになるため（実装書 §4 W1-2）。
   *
   * **道路も例外にしない。** 直線ドラッグは数十タイルなので当初は `canApplyOp` を
   * タイルごとに呼んでいたが、それだと1タイルぶんの残高しか見ないため、
   * タイル費用が一定でない道路（道路10 / 橋50 / 森+5）で
   * 「全部緑なのに橋の手前で止まる」が起きる（レビューで実測再現された）。
   *
   * 3つとも `applyOp` と**同じ走査順・同じ「累積費用が尽きたら以降は不可」ロジック**で
   * 判定する。1タイルぶんの費用だけを見ていると、矩形の途中で予算が尽きる場合に
   * 「プレビューは全部緑なのに一部しか塗られない」という状態になる
   * （`applyOp` のコメントが戒めている「プレビューでは置けるのに建設できない」そのもの）。
   *
   * 長押し削除モード中は常に撤去色（invalid の赤）で見せる。valid/invalid の2色しか
   * 無いので、そのまま使うと「資金不足で置けない」と区別が付かなくなるが、
   * `demolishArea` の費用は道路撤去ぶんだけで通常ごく小さいため、実用上は
   * 「今は削除モードだ」という合図として優先する（実装書 §12.4 W1-4 の判断）。
   *
   * 道路ツールは `roadMode` でさらに3分岐する（T7 §3）。「幹線」「縮小」を
   * `previewBuildRoad` のまま出すと実費と食い違う（幹線は build+upgrade の
   * 合成費用、縮小は全か無か）ので、専用の `previewUpgradeRoad` /
   * `previewDowngradeRoad`（`sim/world.ts`）に判定を任せる。縮小モードで
   * 幹線タイルだけが緑になるのが、そのまま T7 §4 のハイライトになる。
   */
  function previewOf(tiles: TilePos[]): PreviewTile[] {
    if (tiles.length === 0) return [];
    if (longPressActive) {
      return tiles.map((t) => ({ x: t.x, y: t.y, valid: false }));
    }
    const { tool, zone, roadMode } = ui();
    if (tool === 'zone') {
      const valid = previewPaintZone(world, zone, tiles);
      return tiles.map((t, i) => ({ x: t.x, y: t.y, valid: valid[i] ?? false }));
    }
    if (tool === 'demolish') {
      const valid = previewDemolishArea(world, tiles);
      return tiles.map((t, i) => ({ x: t.x, y: t.y, valid: valid[i] ?? false }));
    }
    if (tool === 'road') {
      const valid =
        roadMode === 'arterial'
          ? previewUpgradeRoad(world, tiles)
          : roadMode === 'shrink'
            ? previewDowngradeRoad(world, tiles)
            : previewBuildRoad(world, tiles);
      return tiles.map((t, i) => ({ x: t.x, y: t.y, valid: valid[i] ?? false }));
    }
    return tiles.map((t) => ({ x: t.x, y: t.y, valid: false }));
  }

  /**
   * ドラッグ確定時に出す op の並び。ほとんどのツールは1つだが、道路の「幹線」
   * だけは2つになる（T7 §2: 道路の無いタイルへ `buildRoad` → 線全体へ
   * `upgradeRoad`。どちらも部分適用なので、この順で続けて出せば「更地からでも
   * 1回のドラッグで幹線が引ける」が「資金が途中で尽きても矛盾しない」を両立する）。
   */
  function opsFor(tiles: TilePos[]): BuildOp[] {
    if (tiles.length === 0) return [];
    // 長押し削除モードは選択中ツールを上書きする（実装書 §12.4 W1-4）
    if (longPressActive) return [{ kind: 'demolishArea', tiles }];
    const { tool, zone, roadMode } = ui();
    if (tool === 'road') {
      if (roadMode === 'arterial') {
        return [
          { kind: 'buildRoad', tiles },
          { kind: 'upgradeRoad', tiles },
        ];
      }
      if (roadMode === 'shrink') return [{ kind: 'downgradeRoad', tiles }];
      return [{ kind: 'buildRoad', tiles }];
    }
    if (tool === 'zone') return [{ kind: 'paintZone', zone, tiles }];
    // 撤去ツールは道路・区画・建物をまとめて消す（実装書 §12.4 W1-3）
    if (tool === 'demolish') return [{ kind: 'demolishArea', tiles }];
    // 施設は1タイル（`dragShapeFor` が 'point' を返すので tiles は常に1件）への設置
    // （`docs/m6-plan.md` §2 W4）。sim 側の `placeFacility` はまだ未実装で、
    // `applyOp` は常に失敗を返す——トーストが出るだけで壊れない、という状態
    // （sim 側の実装が入ればそのまま置けるようになる）。
    if (tool === 'facility') {
      const pos = tiles[0];
      return pos ? [{ kind: 'placeFacility', defId: ui().facilityDefId, pos }] : [];
    }
    return [];
  }

  function commitDrag(): void {
    // エリア購入（`docs/m6-plan.md` §2 W1）: 単発タップが「買える土地」に乗っていたら、
    // 選択中のツールに関係なく購入パネルを開く（未購入地に道路・区画・施設を
    // 建てようとしても terrain が undefined でどの道弾かれるだけなので、
    // ここで先に拾ってしまう方が親切）。長押し削除モードは対象外。
    if (!longPressActive && dragTiles.length === 1) {
      const buyable = buyableChunkAt(world, dragTiles[0]!);
      if (buyable) {
        ui().openDistrictPurchase(buyable.cx, buyable.cy);
        dragStart = null;
        dragTiles = [];
        clearLongPressTimer();
        scene.setPreview([]);
        scene.setFacilityPreview(null);
        return;
      }
    }
    let applied = false;
    let failReason: string | null = null;
    for (const op of opsFor(dragTiles)) {
      const result = applyOp(world, op);
      if (result.ok) applied = true;
      else failReason = result.reason;
    }
    // 「幹線」は2op構成なので、1つ目（buildRoad）が失敗の理由を残しても
    // 2つ目（upgradeRoad）が成功すれば上書きされて消える。逆に1つ目が成功した後で
    // 2つ目が資金不足で丸ごと弾かれた（downgradeRoad の全か無か、または
    // upgradeRoad の事前チェック）場合はその理由が残り、トーストで見せる。
    if (failReason) {
      ui().showToast(failReason);
      playSound('error');
    }
    if (applied) {
      emitStateSounds();
      scene.markDirty();
      // 道路の建設・撤去は交差点の形状を変えうる（sim 側が優先設定も自動で
      // 整理する。`pruneIntersectionState`）。マーカーを引き直す
      refreshIntersectionMarkers();
    }
    dragStart = null;
    dragTiles = [];
    longPressActive = false;
    clearLongPressTimer();
    scene.setPreview([]);
    scene.setFacilityPreview(null);
  }

  /** 交差点マーカーを sim の現在状態から作り直す。道路変更時だけ全タイルを再走査する。 */
  function refreshIntersectionMarkers(rescan = true): void {
    if (rescan) cachedIntersections = listIntersections(world);
    scene.setIntersectionMarkers(
      buildIntersectionMarkers(world, ui().tool === 'traffic', cachedIntersections),
    );
  }

  /**
   * 「交通」ツールでのタップ（設計書 §1.2）。
   *
   * ダイアログは出さず、指定なし→東西→南北→指定なしの順に即座に切り替える。
   * 検証は `canApplyOp` に任せる（UI 側で対象形状を判定し直さない）。対象外を
   * タップしたときは、その理由をそのままトーストで出す。
   */
  function cycleIntersectionPriority(pos: TilePos): void {
    const key = tileKey(pos.x, pos.y);
    const current = world.state.intersectionPriorities?.[key] ?? null;
    const axis = nextIntersectionAxis(current);
    const result = applyOp(world, { kind: 'setIntersectionPriority', pos, axis });
    if (!result.ok) {
      ui().showToast(result.reason);
      playSound('error');
      return;
    }
    ui().showToast(tp('traffic.toast', { axis: t(axisLabelKey(axis)) }));
    refreshIntersectionMarkers();
  }

  /** パンツールのタップを、描画位置の車優先で trace とインスペクタへ反映する。 */
  function selectTraceAt(w: Vec2): void {
    const vehicleId = scene.pickVehicle(w);
    if (vehicleId !== null) {
      ui().setSelection(null);
      ui().setSelectedVehicleId(vehicleId);
      scene.setTraceSelection({
        kind: 'vehicle',
        vehicleId,
        isCurrent: () => ui().selectedVehicleId === vehicleId,
        onMissing: () => {
          if (ui().selectedVehicleId === vehicleId) ui().setSelectedVehicleId(null);
        },
      });
      return;
    }

    const pos = worldToTile(w);
    const buildingId = buildingIdAt(world.state.grid, pos.x, pos.y);
    ui().setSelectedVehicleId(null);
    ui().setSelection(pos);
    scene.setTraceSelection(
      buildingId === undefined
        ? null
        : {
            kind: 'building',
            buildingId,
            isCurrent: () => {
              const selected = ui().selection;
              return (
                ui().selectedVehicleId === null && selected?.x === pos.x && selected.y === pos.y
              );
            },
          },
    );
  }

  const detachInput = attachPanZoom(host, cam, {
    // 「交通」ツールはドラッグではなくタップで操作する（設計書 §1.2）。
    // pan と同様に扱うことで、動かさずに離した操作だけが onTap に来る
    // （道路等の建設ドラッグ（onDragStart/onDragMove/onDragEnd）とは競合しない）
    /**
     * 一本指のドラッグをパンに回すツール。**建設しないツールはすべてここに入れる。**
     *
     * 「分析」は M5 §3-2 で足した「情報を見る専用」のツールで、建設も撤去もしない。
     * ここに入れ忘れると `mode='tool'` に落ちてタップが `onTap` に来ず、
     * 分析ツールを選んでも**何も選べない**（W1 と W3 のどちらの担当範囲でもない継ぎ目）。
     */
    allowSinglePointerPan: () =>
      ui().tool === 'pan' || ui().tool === 'traffic' || ui().tool === 'analysis',
    onPointerDown(w: Vec2, screen: Vec2) {
      void unlockAudio();
      // ツール側のドラッグ開始を待つとパン・交通ツールでは長押し自体が存在しなくなる
      armLongPress(w, screen);
    },
    onPointerMove(w: Vec2, screen: Vec2) {
      if (
        longPressTimer !== null &&
        longPressDownAt &&
        Math.hypot(screen.x - longPressDownAt.x, screen.y - longPressDownAt.y) >=
          INPUT.LONG_PRESS_SLOP_PX
      ) {
        // タイル差では倍率によって解除の感触が変わるため、指の移動量を画面pxで測る
        clearLongPressTimer();
      }
      if (!longPressActive) return false;
      updateDrag(worldToTile(w));
      return true;
    },
    onPointerUp(w: Vec2) {
      if (!longPressActive) {
        clearLongPressTimer();
        return false;
      }
      updateDrag(worldToTile(w));
      commitDrag();
      return true;
    },
    onPointerCancel() {
      cancelDrag();
    },
    onDragStart(w: Vec2) {
      dragStart = worldToTile(w);
      updateDrag(dragStart);
    },
    onDragMove(w: Vec2) {
      updateDrag(worldToTile(w));
    },
    onDragEnd() {
      commitDrag();
    },
    onDragCancel() {
      cancelDrag();
    },
    /**
     * タップでインスペクタの対象を選ぶ（パネルの中身は W3b）。
     *
     * `attachPanZoom` はパンツール選択中の「動かさずに離した」操作だけを onTap にする。
     * 建設ツール中のタップは従来どおり onDragEnd（＝1タイルの建設）になる。
     * **タップを常に選択へ回すと1タイルだけ道路を置く操作が失われるため、この
     * 住み分けを保つ**（`docs/m3-plan.md` §4 W0-0-2 の記述はこの実装に合わせて改訂した）。
     *
     * 「交通」ツール選択中は同じ経路（動かさずに離したタップ）を優先道路の
     * 巡回に使う（設計書 §1.2）。インスペクタの選択には回さない
     * （操作は「交通」ツールに一本化し、インスペクタは読むだけにする §1.6）。
     */
    onTap(w: Vec2) {
      const pos = worldToTile(w);
      // エリア購入（`docs/m6-plan.md` §2 W1）: パン・交通・分析ツールはタップを
      // ここ（onTap）で受ける。「交通」の巡回・「分析」の選択より先に判定することで、
      // どのツールを選んでいても買える土地を素通りしない。
      const buyable = buyableChunkAt(world, pos);
      if (buyable) {
        ui().setSelection(null);
        ui().setSelectedVehicleId(null);
        scene.setTraceSelection(null);
        ui().openDistrictPurchase(buyable.cx, buyable.cy);
        return;
      }
      if (ui().tool === 'traffic') {
        ui().setSelection(null);
        ui().setSelectedVehicleId(null);
        scene.setTraceSelection(null);
        cycleIntersectionPriority(pos);
        return;
      }
      // 情報を開くのは「分析」ツールだけ（M5 §3-2）。
      // オーナー報告「開こうとしていない家の情報パネルが開く」への構造的な解で、
      // 閾値の調整では直らない。store 側にも同じ趣旨のガードがあるが、
      // **ここで弾かないと描画側のハイライト処理（setTraceSelection）が空振りで走る**。
      if (ui().tool !== 'analysis') {
        ui().setSelection(null);
        ui().setSelectedVehicleId(null);
        scene.setTraceSelection(null);
        return;
      }
      selectTraceAt(w);
    },
  });

  function pushHud(): void {
    const s = world.state;
    const stats = currentStats(s);
    const d = currentDemand(s);
    const r = s.progress.lastDayReport;
    const snapshot: HudSnapshot = {
      money: s.money,
      population: stats.population,
      day: day(s),
      demand: {
        residential: d.residential,
        commercial: d.commercial,
        industrial: d.industrial,
      },
      vehicles: s.vehicles.length,
      lastDay: r
        ? {
            taxR: r.taxR,
            taxC: r.taxC,
            taxI: r.taxI,
            upkeepRoad: r.upkeepRoad,
            upkeepFacility: r.upkeepFacility,
          }
        : null,
      // マイルストーン進捗（`docs/m6-plan.md` §2 W3）。達成判定は sim 側が別途実装中
      // （現状は常に空配列）だが、届いた分だけそのまま出せる形にしておく
      achievedMilestones: s.progress.achievedMilestones,
    };
    ui().setHud(snapshot);
  }

  function frame(now: number): void {
    const dt = Math.min(now - lastFrame, 250); // タブ復帰時の巨大な dt を切る
    lastFrame = now;

    // 施設UIが別の操作経路から state を更新しても、ポーズ中を含めて次フレームで購読する。
    if (
      world.state.facilities.length !== knownFacilityIds.size ||
      world.state.progress.achievedMilestones.length !== knownMilestoneIds.size
    ) {
      emitStateSounds();
    }

    const speed = ui().speed;
    if (speed > 0) {
      accumulator += dt * speed;
      let ticks = Math.floor(accumulator / MS_PER_TICK);
      if (ticks > MAX_TICKS_PER_FRAME) {
        ticks = MAX_TICKS_PER_FRAME;
        accumulator = 0;
      } else {
        accumulator -= ticks * MS_PER_TICK;
      }
      if (ticks > 0) {
        // **tick を進める直前の状態を「前tick」として控える。**
        // 補間の元は「前フレーム」ではなく「前tick」でなければならない（下記参照）
        prevTickViews.clear();
        for (const v of currTickViews) prevTickViews.set(v.id, v);

        const before = world.state.buildings.length;
        const dayBefore = day(world.state);
        advance(world, ticks);
        emitStateSounds();
        if (day(world.state) !== dayBefore) void persist('auto', false);
        // 現示はtickで切り替わる。座標一覧はキャッシュし、青／赤だけを追従させる。
        refreshIntersectionMarkers(false);
        // 建物が増減したら描き直す（毎フレーム全部描くのは重い）
        if (world.state.buildings.length !== before) scene.markDirty();

        currTickViews = vehicleViews(world.state);
        // 流量オーバーレイ（M5 §4-3）: 実tickが進んだときだけサンプリングする
        // （毎フレーム呼ぶと倍速時に同じ移動を何度も数えて水増しになる）。
        updateFlow(flow, passCountsFromViews(prevTickViews, currTickViews));
      }
    }

    if (!zoomFitted) {
      const w = scene.app.screen.width;
      const h = scene.app.screen.height;
      if (w > 0 && h > 0) {
        // 開始チャンクが画面を埋める倍率にする（縦長の端末では横がはみ出す）
        const fit = Math.max(w, h) / (SPACE.CHUNK_SIZE * SPACE.TILE_PX);
        cam.zoom = Math.min(SPACE.ZOOM_MAX, Math.max(SPACE.ZOOM_MIN, fit));
        zoomFitted = true;
      }
    }

    // シミュは10 tick/秒、描画は60fps。tick の合間は「前tick → 現tick」を
    // alpha（次tickまでの残余時間の割合）で補間して埋め、カクつきを消す。
    //
    // **補間の元を毎フレーム上書きしてはいけない。** 以前は毎フレーム
    // `prev = curr` としていたが、シミュは tick でしか変わらないので、
    // tick が起きないフレームでは prev と curr が同じ値になり補間が何もしない。
    // 結果として「tick が起きたフレームだけ動いて、次のフレームで目的地へ飛ぶ」
    // という、補間を入れる前と同じカクつきになっていた（建物への出入りが
    // 飛んで見えたのもこれが主因）。
    const alpha = Math.min(1, Math.max(0, accumulator / MS_PER_TICK));
    scene.render(world, interpolateVehicleViews(prevTickViews, currTickViews, alpha), cam, flow);

    if (now - lastHud > HUD_INTERVAL_MS) {
      lastHud = now;
      pushHud();
    }
  }

  scene.app.ticker.add((ticker) => frame(ticker.lastTime));
  pushHud();

  /**
   * オーバーレイの選択を描画へ繋ぐ（実装書 §12.3）。
   *
   * ここで配線を済ませておくことで、オーバーレイの中身を書く担当は
   * `src/render/overlay.ts` だけを触れば済む（このファイルを触らせない）。
   */
  let lastOverlay = ui().overlay;
  scene.setOverlay(overlayDrawFor(lastOverlay));
  const unsubscribeOverlay = useUiStore.subscribe((s) => {
    if (s.overlay === lastOverlay) return;
    lastOverlay = s.overlay;
    scene.setOverlay(overlayDrawFor(s.overlay));
  });

  /**
   * 交差点マーカーの初期描画と、「交通」ツールの選択・解除への追従（設計書 §1.3 A・D）。
   *
   * 光らせるかどうか（highlighted）は「交通」ツール選択中かどうかだけで決まるので、
   * それ以外のツール切替では引き直さない（無駄なフルスキャンを避ける）。
   */
  refreshIntersectionMarkers();
  let trafficToolActive = ui().tool === 'traffic';
  const unsubscribeTool = useUiStore.subscribe((s) => {
    const active = s.tool === 'traffic';
    if (active === trafficToolActive) return;
    trafficToolActive = active;
    refreshIntersectionMarkers(false);
  });

  /**
   * エリア購入パネル（`ui/components/DistrictPurchase.tsx`）の「購入」ボタンから
   * `applyOp` を呼べるようにする橋渡し（`docs/m6-plan.md` §2 W1）。詳細は
   * `game/actions.ts` の説明を参照。成功時は新しいチャンクの地形を描くために
   * `scene.markDirty()` を呼ぶ——これは `startGame` のクロージャの中でしかできない。
   */
  setBuyDistrictAction(world, (cx, cy) => {
    const result = applyOp(world, { kind: 'buyDistrict', cx, cy });
    if (result.ok) scene.markDirty();
    else ui().showToast(result.reason);
    return result;
  });

  return {
    world,
    destroy() {
      // 自分が登録した World のときだけ消す（StrictMode の二重実行対策。current.ts 参照）
      clearCurrentWorld(world);
      if (activeSaveWorld === world) {
        activeSaveWorld = null;
        if (activeSaveControls === controls) activeSaveControls = null;
      }
      clearBuyDistrictAction(world);
      clearLongPressTimer();
      unsubscribeOverlay();
      unsubscribeTool();
      detachInput();
      scene.destroy();
    },
  };
}

/**
 * 開始点と終了点を対角とする矩形のタイルを列挙する（実装書 §12.3 区画/撤去・W1-2）。
 * 開始点・終了点のどちらが左上/右下でも同じ矩形になる（min/max を取るだけなので）。
 * `export` はテスト（`loop.test.ts`）から直接呼ぶため。
 */
export function rectTiles(a: TilePos, b: TilePos): TilePos[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const tiles: TilePos[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}

/**
 * 終点を水平・垂直・45度のいずれかにスナップする（D2）。
 * 斜めが成立するのは道路グラフを8方向接続にしているため（D3）。
 */
function snapToStraight(from: TilePos, to: TilePos): TilePos {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx >= ady * 2) return { x: from.x + dx, y: from.y };
  if (ady >= adx * 2) return { x: from.x, y: from.y + dy };
  const len = Math.min(adx, ady);
  return { x: from.x + Math.sign(dx) * len, y: from.y + Math.sign(dy) * len };
}

/** a→b 間の格子タイルを歯抜けなく列挙する */
function bresenham(a: TilePos, b: TilePos): TilePos[] {
  const points: TilePos[] = [];
  let x0 = a.x;
  let y0 = a.y;
  const dx = Math.abs(b.x - x0);
  const dy = -Math.abs(b.y - y0);
  const sx = x0 < b.x ? 1 : -1;
  const sy = y0 < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    points.push({ x: x0, y: y0 });
    if (x0 === b.x && y0 === b.y) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return points;
}

/**
 * 前フレーム（`prevViews`）と現フレーム（`currViews`）の位置を `alpha` で補間する
 * （実装書 §2.1 / GPT-5レビュー「tick境界の補間」）。
 *
 * `export` はテスト（`loop.test.ts`）から直接呼ぶため。x/y/angle 以外のフィールド
 * （`edgeProgress` / `exitEdge` / `entranceEdge` / `exitPos` / `entrancePos` 等）は
 * 常に現フレームの値をそのまま使う。これらは「今どの辺のどこにいるか」という
 * シミュ側の意味を持つ値であり、補間すると別の辺の値と混ざって意味を失う
 * （建物出入りの区間判定がズレる）。
 *
 * 前フレームに id が無い（新規出現・滞在明けの復路開始）、または位置が
 * `MAX_INTERP_DISTANCE` タイル以上離れている（動的迂回・倍速での複数tick消化）場合は
 * 補間せず現フレームの view をそのまま返す。
 */
export function interpolateVehicleViews(
  prevViews: ReadonlyMap<number, VehicleView>,
  currViews: readonly VehicleView[],
  alpha: number,
): VehicleView[] {
  const a = Math.min(1, Math.max(0, alpha));
  const out: VehicleView[] = [];
  for (const curr of currViews) {
    const prev = prevViews.get(curr.id);
    if (!prev) {
      out.push(curr);
      continue;
    }
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    if (dx * dx + dy * dy >= MAX_INTERP_DISTANCE_SQ) {
      out.push(curr);
      continue;
    }
    out.push(interpolateOne(prev, curr, a));
  }
  return out;
}

/** 1台ぶんの補間。直進中は線形補間、曲がり角をまたぐ場合はフィレット（2次ベジェ）を使う */
function interpolateOne(prev: VehicleView, curr: VehicleView, alpha: number): VehicleView {
  const d0x = Math.cos(prev.angle);
  const d0y = Math.sin(prev.angle);
  const d1x = Math.cos(curr.angle);
  const d1y = Math.sin(curr.angle);
  const dot = d0x * d1x + d0y * d1y;

  if (dot > CORNER_DOT_THRESHOLD) {
    return {
      ...curr,
      x: prev.x + (curr.x - prev.x) * alpha,
      y: prev.y + (curr.y - prev.y) * alpha,
      angle: curr.angle,
    };
  }

  const fillet = filletPoint(prev.x, prev.y, d0x, d0y, curr.x, curr.y, d1x, d1y, alpha);
  if (!fillet) {
    return {
      ...curr,
      x: prev.x + (curr.x - prev.x) * alpha,
      y: prev.y + (curr.y - prev.y) * alpha,
      angle: curr.angle,
    };
  }
  return { ...curr, x: fillet.x, y: fillet.y, angle: fillet.angle };
}

/**
 * 曲がり角のフィレット（角の手前から次の辺へ2次ベジェで繋ぐ）。
 *
 * 制御点は、前の辺の方向 `d0`（`prev` を通る直線）と現在の辺の方向 `d1`
 * （`curr` を通る直線）を延長した交点にする。道路は折れ線（タイル中心を結ぶ直線）
 * なので、この交点は理論上ちょうど曲がり角のタイル中心に一致する。
 *
 * この作り方だと2次ベジェは常に `prev`・制御点・`curr` の3点が作る三角形の内側に
 * 収まる（凸包の性質）。**Catmull-Rom は使わない**——複数点を通る global なスプラインは
 * 区間によっては制御点の外側までオーバーシュートし、車が道路の外にはみ出して見える
 * （GPT-5レビューで明示的に指摘された）。この2次ベジェは決してその角の外側へは出ない。
 *
 * 向きは位置の式をそのまま微分した接線から求める（位置と向きがズレると横滑って見える）。
 *
 * 2つの辺の方向がほぼ平行（真っ直ぐ、または行き止まりでの180度反転）だと交点が
 * 求まらない・遠くへ飛ぶので、その場合は呼び出し側で線形補間にフォールバックする。
 */
function filletPoint(
  p0x: number,
  p0y: number,
  d0x: number,
  d0y: number,
  p2x: number,
  p2y: number,
  d1x: number,
  d1y: number,
  alpha: number,
): { x: number; y: number; angle: number } | null {
  const det = d1x * d0y - d0x * d1y;
  if (Math.abs(det) < 1e-6) return null;

  const dx = p2x - p0x;
  const dy = p2y - p0y;
  const t = (d1x * dy - dx * d1y) / det;
  const cx = p0x + t * d0x;
  const cy = p0y + t * d0y;

  const u = 1 - alpha;
  const x = u * u * p0x + 2 * u * alpha * cx + alpha * alpha * p2x;
  const y = u * u * p0y + 2 * u * alpha * cy + alpha * alpha * p2y;
  const tx = 2 * u * (cx - p0x) + 2 * alpha * (p2x - cx);
  const ty = 2 * u * (cy - p0y) + 2 * alpha * (p2y - cy);
  if (tx === 0 && ty === 0) return null;
  return { x, y, angle: Math.atan2(ty, tx) };
}
