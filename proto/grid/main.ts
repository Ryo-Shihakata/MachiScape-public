/**
 * P0 グリッド試作: エントリポイント（proto/README.md / 計画書 §7・実装書 §19 P0）。
 * 固定地形 + グリッド道路の建設/撤去 + 共通ダミー交通 + パン/ズーム + デバッグHUD。
 *
 * 操作感は Mini Motorways 準拠（D1 で確定）:
 * - 道を引き始めたら、指の軌跡ではなく「開始タイルから今の指まで」を常に直線で描く
 * - 直線は水平・垂直・45度にスナップするので、どう指を動かしても線は必ずまっすぐ
 * - 指を離した瞬間に確定する
 */
import { attachPanZoom, createCamera, worldToTile, type Vec2 } from '../../src/render/camera';
import { createDebugHud } from '../../src/render/debugHud';
import { currentTheme } from '../../src/render/theme';
import { DummyTraffic } from '../shared/dummyTraffic';
import { GridNetwork } from './gridNetwork';
import { createGridScene, type PreviewTile } from './scene';
import { canBuildRoad, generateTerrain, MAP_SEED, MAP_SIZE } from './terrain';

type Tool = 'pan' | 'road' | 'erase';
type Tile = { x: number; y: number };

async function main(): Promise<void> {
  const host = document.getElementById('canvas-host');
  if (!host) throw new Error('#canvas-host が見つかりません');

  const theme = currentTheme();
  const terrain = generateTerrain(MAP_SIZE, MAP_SEED);
  const net = new GridNetwork();
  const traffic = new DummyTraffic(net);

  const scene = await createGridScene(host, theme, terrain, net);
  const hud = createDebugHud(host);

  const cam = createCamera(MAP_SIZE / 2, MAP_SIZE / 2, 1);

  let tool: Tool = 'road';
  let dragTiles: Tile[] = [];
  let dragStart: Tile | null = null;

  function tileValidFor(x: number, y: number): boolean {
    if (tool === 'road') return canBuildRoad(terrain, MAP_SIZE, x, y);
    if (tool === 'erase') return net.has(x, y);
    return false;
  }

  /**
   * 開始タイルから現在のタイルまでの直線を引き直す。
   * 指の軌跡は覚えず毎回引き直すので、行き過ぎても戻せば線も戻る。
   */
  function setStraightDrag(to: Tile): void {
    if (!dragStart) return;
    const end = snapToStraight(dragStart, to);
    dragTiles = bresenham(dragStart, end).filter(
      (p) => p.x >= 0 && p.y >= 0 && p.x < MAP_SIZE && p.y < MAP_SIZE,
    );
  }

  function updatePreview(): void {
    const preview: PreviewTile[] = dragTiles.map((t) => ({
      x: t.x,
      y: t.y,
      valid: tileValidFor(t.x, t.y),
    }));
    scene.setPreview(preview);
  }

  function resetDrag(): void {
    dragTiles = [];
    dragStart = null;
    scene.setPreview([]);
  }

  /** 指を離した瞬間に、ドラッグで集めたタイルをまとめて確定する */
  function commitDrag(): void {
    if (tool === 'road') {
      for (const t of dragTiles) {
        if (canBuildRoad(terrain, MAP_SIZE, t.x, t.y)) net.addRoad(t.x, t.y);
      }
    } else if (tool === 'erase') {
      for (const t of dragTiles) net.removeRoad(t.x, t.y);
    }
    resetDrag();
    scene.redrawRoads();
  }

  attachPanZoom(host, cam, {
    allowSinglePointerPan: () => tool === 'pan',
    onDragStart(world: Vec2) {
      if (tool === 'pan') return;
      const t = worldToTile(world);
      resetDrag();
      dragStart = t;
      setStraightDrag(t);
      updatePreview();
    },
    onDragMove(world: Vec2) {
      if (tool === 'pan') return;
      setStraightDrag(worldToTile(world));
      updatePreview();
    },
    onDragEnd(_world: Vec2) {
      if (tool === 'pan') return;
      commitDrag();
    },
  });

  const toolButtons = document.querySelectorAll<HTMLButtonElement>('#toolbar button[data-tool]');
  for (const btn of toolButtons) {
    btn.addEventListener('click', () => {
      resetDrag();
      tool = (btn.dataset.tool ?? 'pan') as Tool;
      for (const b of toolButtons) b.classList.toggle('active', b === btn);
    });
  }

  scene.app.ticker.add((ticker) => {
    const dt = ticker.deltaMS / 1000;
    traffic.update(dt);
    scene.renderCars(traffic.views());
    scene.applyCamera(cam);
    hud.update({ cars: traffic.activeCount(), tool });
  });
}

/**
 * 終点を水平・垂直・45度のいずれかにスナップする。
 * どこへ指を動かしても線が必ずまっすぐ見えるようにするための処理
 * （スナップしないと任意角の線は階段状になり「直線」に見えない）。
 *
 * 斜めが成立するのは道路グラフを8方向接続にしてあるため（gridNetwork.ts）。
 */
function snapToStraight(from: Tile, to: Tile): Tile {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  // 軸に十分寄っていればその軸へ倒す。それ以外は45度にする
  if (adx >= ady * 2) return { x: from.x + dx, y: from.y };
  if (ady >= adx * 2) return { x: from.x, y: from.y + dy };
  const len = Math.min(adx, ady);
  return { x: from.x + Math.sign(dx) * len, y: from.y + Math.sign(dy) * len };
}

/** Bresenham のライン描画アルゴリズム。a→b 間の格子タイルを歯抜けなく列挙する */
function bresenham(a: Tile, b: Tile): Tile[] {
  const points: Tile[] = [];
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

void main();
