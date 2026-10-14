/**
 * P0 試作: ヘックス方式（計画書 §7 / 実装書 §19 P0）。
 * 道路の建設・撤去 + 共通ダミー交通の描画のみ。経済・区画・セーブ等は一切扱わない。
 *
 * 描画方針: マップは固定サイズなので、地形は起動時に一度だけ world コンテナへ描画し、
 * 毎フレームは world コンテナの position/scale をカメラから再計算するだけにする
 * （src/render/gridScene.ts のような「毎フレーム線を引き直す」方式は無限グリッド前提のため、
 * 有限マップのヘックス版ではコンテナ変換の方が素直で軽い）。
 */

import { Application, Container, Graphics } from 'pixi.js';
import {
  attachPanZoom,
  createCamera,
  tileScreenSize,
  type Camera,
  type PointerHandlers,
  type Vec2,
} from '../../src/render/camera';
import { currentTheme } from '../../src/render/theme';
import { createDebugHud } from '../../src/render/debugHud';
import { DummyTraffic, PROTO_CAR_COUNT } from '../shared/dummyTraffic';
import { generateTerrain, inMap } from './mapgen';
import { HexNetwork } from './hexNetwork';
import { axialKey, axialToWorld, hexCorners, hexLine, parseKey, worldToAxial, type Axial } from './hexMath';

type Tool = 'pan' | 'road' | 'remove';

const host = document.getElementById('app');
if (!host) throw new Error('#app が見つかりません');

const theme = currentTheme();

// --- 地形・ネットワーク・交通（Pixiに依存しない状態） ---
const terrain = generateTerrain();
const net = new HexNetwork(terrain);
const traffic = new DummyTraffic(net);

// --- Pixi アプリケーション ---
const app = new Application();
await app.init({
  resizeTo: host,
  background: theme.background,
  antialias: true,
  resolution: Math.min(window.devicePixelRatio || 1, 2),
  autoDensity: true,
});
host.appendChild(app.canvas);
app.canvas.style.display = 'block';

const world = new Container();
app.stage.addChild(world);

const terrainLayer = new Graphics();
const roadLayer = new Graphics();
const previewLayer = new Graphics();
const carsLayer = new Container();
world.addChild(terrainLayer, roadLayer, previewLayer, carsLayer);

// --- 地形を一度だけ描画（水・山は塗り、平地はヘックス罫線のみで背景を見せる） ---
for (const [key, type] of terrain) {
  const { q, r } = parseKey(key);
  const { x, y } = axialToWorld(q, r);
  const pts = hexCorners(x, y);
  if (type === 'water') {
    terrainLayer.poly(pts).fill(theme.water);
  } else if (type === 'mountain') {
    terrainLayer.poly(pts).fill(theme.mountain);
  }
  terrainLayer.poly(pts).stroke({ width: 0.035, color: theme.gridLine });
}

// --- 道路レイヤ（ネットワークの version が変わったときだけ描き直す） ---
let drawnRoadVersion = -1;
function redrawRoads(): void {
  roadLayer.clear();
  const nodes = net.nodes();
  // ヘックスは隙間なく敷き詰まるので、先に全部塗ってから縁取りを重ねると
  // 隣接セルの塗りが自分の縁取りを消してしまう問題を避けられる
  for (const node of nodes) {
    const pts = hexCorners(node.x, node.y);
    roadLayer.poly(pts).fill(theme.road);
  }
  for (const node of nodes) {
    const pts = hexCorners(node.x, node.y);
    roadLayer.poly(pts).stroke({ width: 0.04, color: theme.roadOutline });
  }
}

// --- 建設/撤去プレビューレイヤ ---
function redrawPreview(): void {
  previewLayer.clear();
  if (currentTool === 'pan') return;
  for (const cell of dragCells.values()) {
    const key = axialKey(cell.q, cell.r);
    const t = terrain.get(key);
    const valid = currentTool === 'road' ? t !== undefined && t !== 'mountain' : net.hasRoad(cell.q, cell.r);
    const { x, y } = axialToWorld(cell.q, cell.r);
    const pts = hexCorners(x, y);
    previewLayer.poly(pts).fill({ color: valid ? theme.preview : theme.previewInvalid, alpha: 0.55 });
  }
}

// --- 車（プールを使い回し、毎フレームは transform だけ更新する） ---
const carPool: Graphics[] = [];
for (let i = 0; i < PROTO_CAR_COUNT; i++) {
  const car = new Graphics();
  car
    .poly([
      { x: 0.32, y: 0 },
      { x: -0.22, y: 0.18 },
      { x: -0.22, y: -0.18 },
    ])
    .fill(theme.vehicleCar);
  car.visible = false;
  carsLayer.addChild(car);
  carPool.push(car);
}

function updateCars(): void {
  const views = traffic.views();
  for (let i = 0; i < carPool.length; i++) {
    const car = carPool[i];
    if (!car) continue;
    const v = views[i];
    if (!v) {
      car.visible = false;
      continue;
    }
    car.visible = true;
    car.position.set(v.x, v.y);
    car.rotation = v.angle;
  }
}

// --- カメラ ---
const camera: Camera = createCamera(0, 0, 1);

function applyCameraTransform(): void {
  const w = app.renderer.width / app.renderer.resolution;
  const h = app.renderer.height / app.renderer.resolution;
  const s = tileScreenSize(camera);
  world.scale.set(s);
  world.position.set(w / 2 - camera.x * s, h / 2 - camera.y * s);
}

// --- ツール状態とドラッグ処理 ---
let currentTool: Tool = 'pan';
const dragCells = new Map<string, Axial>();
let lastCell: Axial | null = null;

function addDragCell(c: Axial): void {
  dragCells.set(axialKey(c.q, c.r), c);
}

function cellAt(p: Vec2): Axial {
  return worldToAxial(p.x, p.y);
}

function commitDrag(): void {
  for (const cell of dragCells.values()) {
    if (!inMap(cell.q, cell.r)) continue;
    if (currentTool === 'road') net.addRoad(cell.q, cell.r);
    else if (currentTool === 'remove') net.removeRoad(cell.q, cell.r);
  }
}

const handlers: PointerHandlers = {
  allowSinglePointerPan: () => currentTool === 'pan',
  onDragStart(worldPos) {
    if (currentTool === 'pan') return;
    const c = cellAt(worldPos);
    dragCells.clear();
    addDragCell(c);
    lastCell = c;
    redrawPreview();
  },
  onDragMove(worldPos) {
    if (currentTool === 'pan' || !lastCell) return;
    const c = cellAt(worldPos);
    if (c.q !== lastCell.q || c.r !== lastCell.r) {
      for (const cell of hexLine(lastCell, c)) addDragCell(cell);
      lastCell = c;
    }
    redrawPreview();
  },
  onDragEnd(worldPos) {
    if (currentTool === 'pan') return;
    if (lastCell) {
      const c = cellAt(worldPos);
      for (const cell of hexLine(lastCell, c)) addDragCell(cell);
    }
    commitDrag();
    dragCells.clear();
    lastCell = null;
    redrawPreview();
  },
};

attachPanZoom(app.canvas, camera, handlers);

// --- ツールバー（下部の簡易DOMボタン） ---
const toolbar = document.createElement('div');
toolbar.style.cssText = [
  'position:absolute',
  'left:0',
  'right:0',
  'bottom:env(safe-area-inset-bottom,0px)',
  'display:flex',
  'justify-content:center',
  'gap:8px',
  'padding:10px',
  'pointer-events:auto',
  'z-index:10',
].join(';');
host.appendChild(toolbar);

const TOOL_LABEL: Record<Tool, string> = { pan: 'パン', road: '道路', remove: '撤去' };
const buttons = new Map<Tool, HTMLButtonElement>();

function refreshToolbar(): void {
  for (const [tool, btn] of buttons) {
    const active = tool === currentTool;
    btn.style.background = active ? theme.text : theme.panel;
    btn.style.color = active ? theme.panel : theme.text;
  }
}

for (const tool of ['pan', 'road', 'remove'] as const) {
  const btn = document.createElement('button');
  btn.textContent = TOOL_LABEL[tool];
  btn.style.cssText = [
    'font:14px/1.4 system-ui,sans-serif',
    'padding:10px 18px',
    'border-radius:10px',
    'border:none',
    'box-shadow:0 2px 6px rgba(0,0,0,0.2)',
    'min-width:72px',
  ].join(';');
  btn.addEventListener('click', () => {
    currentTool = tool;
    dragCells.clear();
    lastCell = null;
    redrawPreview();
    refreshToolbar();
  });
  toolbar.appendChild(btn);
  buttons.set(tool, btn);
}
refreshToolbar();

// --- HUD ---
const hud = createDebugHud(host);

// --- メインループ ---
app.ticker.add((ticker) => {
  const dt = ticker.deltaMS / 1000;
  traffic.update(dt);
  applyCameraTransform();
  if (net.version !== drawnRoadVersion) {
    redrawRoads();
    drawnRoadVersion = net.version;
  }
  updateCars();
  hud.update({ cars: traffic.activeCount() });
});
