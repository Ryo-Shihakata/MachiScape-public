/**
 * P0 自由曲線方式のエントリポイント（アンカー + Catmull-Rom スプライン）。
 * 依頼書 proto/spline のやること1〜7を束ねる。交通ロジックは書かず proto/shared を使う。
 */

import { Application, Container } from 'pixi.js';
import { attachPanZoom, createCamera, tileScreenSize, type Vec2 } from '../../src/render/camera';
import { currentTheme } from '../../src/render/theme';
import { createDebugHud } from '../../src/render/debugHud';
import { DummyTraffic, PROTO_CAR_COUNT } from '../shared/dummyTraffic';
import { generateTerrain, WORLD_TILES } from './terrain';
import { SplineNetwork } from './splineNetwork';
import { buildTerrainLayer, buildRoadLayer, buildPreviewLayer, createCarPool } from './render';

type Tool = 'pan' | 'road' | 'erase';

/** 決定論的な固定マップのシード */
const SEED = 20260729;
/** ドラッグ中、この距離以上動いたら新しいアンカーを打つ（タイル単位） */
const ANCHOR_MIN_DIST = 0.3;

async function main(): Promise<void> {
  const stage = document.getElementById('stage');
  if (!stage) throw new Error('#stage が見つからない');

  const theme = currentTheme();
  const app = new Application();
  await app.init({
    resizeTo: stage,
    background: theme.background,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  stage.appendChild(app.canvas);

  const world = new Container();
  app.stage.addChild(world);

  // 1. 固定地形
  const terrainGrid = generateTerrain(SEED);
  world.addChild(buildTerrainLayer(terrainGrid, theme));

  // 3. ProtoNetwork（自由曲線）
  const network = new SplineNetwork();
  const roadSlot = new Container();
  world.addChild(roadSlot);
  roadSlot.addChild(buildRoadLayer(network, theme));
  let lastNetVersion = network.version;

  // 2. 道路プレビュー（ドラッグ中の描画中の曲線）
  const preview = buildPreviewLayer(theme);
  world.addChild(preview.container);

  // 4. ダミー交通
  const carPool = createCarPool(theme, PROTO_CAR_COUNT);
  world.addChild(carPool.container);
  const traffic = new DummyTraffic(network);

  // 7. HUD
  const hud = createDebugHud(stage);

  // カメラは地図中央から開始
  const camera = createCamera(WORLD_TILES / 2, WORLD_TILES / 2, 1);

  // 6. ツール切り替え
  let tool: Tool = 'pan';
  let anchors: Vec2[] = [];
  const toolButtons = document.querySelectorAll<HTMLButtonElement>('.tool-btn');
  const setTool = (t: Tool): void => {
    tool = t;
    for (const btn of toolButtons) {
      btn.classList.toggle('active', btn.dataset.tool === t);
    }
  };
  for (const btn of toolButtons) {
    btn.addEventListener('click', () => {
      const chosen = btn.dataset.tool as Tool | undefined;
      if (chosen) setTool(chosen);
    });
  }
  setTool(tool);

  attachPanZoom(stage, camera, {
    allowSinglePointerPan: () => tool === 'pan',
    onDragStart(worldPos) {
      if (tool === 'road') {
        anchors = [worldPos];
        preview.setPoints(anchors);
      } else if (tool === 'erase') {
        network.eraseAt(worldPos.x, worldPos.y);
      }
    },
    onDragMove(worldPos) {
      if (tool === 'road') {
        const lastAnchor = anchors[anchors.length - 1];
        if (!lastAnchor || Math.hypot(worldPos.x - lastAnchor.x, worldPos.y - lastAnchor.y) >= ANCHOR_MIN_DIST) {
          anchors.push(worldPos);
        }
        preview.setPoints(anchors);
      } else if (tool === 'erase') {
        network.eraseAt(worldPos.x, worldPos.y);
      }
    },
    onDragEnd(worldPos) {
      if (tool === 'road') {
        const lastAnchor = anchors[anchors.length - 1];
        if (!lastAnchor || Math.hypot(worldPos.x - lastAnchor.x, worldPos.y - lastAnchor.y) >= ANCHOR_MIN_DIST * 0.5) {
          anchors.push(worldPos);
        }
        network.buildRoad(anchors);
        anchors = [];
        preview.setPoints([]);
      }
    },
  });

  app.ticker.add((ticker) => {
    const dt = ticker.deltaMS / 1000;
    traffic.update(dt);

    // カメラ→画面変換をワールドコンテナ1つの scale/position に反映する
    const s = tileScreenSize(camera);
    world.scale.set(s);
    world.position.set(app.screen.width / 2 - camera.x * s, app.screen.height / 2 - camera.y * s);

    if (network.version !== lastNetVersion) {
      lastNetVersion = network.version;
      const old = roadSlot.removeChildren();
      for (const c of old) c.destroy({ children: true });
      roadSlot.addChild(buildRoadLayer(network, theme));
    }

    carPool.update(traffic.views());
    hud.update({ cars: traffic.activeCount() });
  });
}

main().catch((err: unknown) => {
  console.error(err);
});
