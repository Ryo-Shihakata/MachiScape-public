/**
 * P0 グリッド試作: Pixi描画（計画書 §6 アート方針 = フラットな単色図形 + ソフトシャドウ）。
 * カメラ変換はコンテナ全体（world）にまとめて掛け、地形・道路・車はワールド座標（タイル単位）で描く。
 * こうすると地形は一度描くだけで済み、パン/ズーム中の再描画コストがかからない。
 */
import { Application, BlurFilter, Container, Graphics } from 'pixi.js';
import type { Camera } from '../../src/render/camera';
import { tileScreenSize, worldToScreen } from '../../src/render/camera';
import type { Theme } from '../../src/render/theme';
import type { CarView } from '../shared/dummyTraffic';
import type { GridNetwork } from './gridNetwork';
import type { TileKind } from './terrain';

export interface PreviewTile {
  x: number;
  y: number;
  valid: boolean;
}

export interface GridScene {
  app: Application;
  /** 現在の建設/撤去プレビューを描き直す（空配列で消去） */
  setPreview(tiles: PreviewTile[]): void;
  /** 道路タイルが変化したときに呼ぶ */
  redrawRoads(): void;
  /** 毎フレーム、車の現在位置で描き直す */
  renderCars(views: CarView[]): void;
  /** 毎フレーム、カメラの現在値でワールドコンテナの変換を更新する */
  applyCamera(cam: Camera): void;
  destroy(): void;
}

export async function createGridScene(
  host: HTMLElement,
  theme: Theme,
  terrain: TileKind[][],
  net: GridNetwork,
): Promise<GridScene> {
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
  const gridLineLayer = new Graphics();
  const mountainShadowLayer = new Graphics();
  const roadShadowLayer = new Graphics();
  const roadLayer = new Graphics();
  const previewLayer = new Graphics();
  const carShadowLayer = new Graphics();
  const carLayer = new Graphics();

  // ソフトシャドウはコストを抑えるため、変化が少ないレイヤ（道路・車）だけにぼかしを掛ける
  roadShadowLayer.filters = [new BlurFilter({ strength: 3, quality: 2 })];
  carShadowLayer.filters = [new BlurFilter({ strength: 2, quality: 2 })];

  world.addChild(
    terrainLayer,
    gridLineLayer,
    mountainShadowLayer,
    roadShadowLayer,
    roadLayer,
    previewLayer,
    carShadowLayer,
    carLayer,
  );

  drawTerrainOnce(terrainLayer, mountainShadowLayer, terrain, theme);
  // グリッド方式の評価にはタイル境界の視認性が要る（どこにスナップするかが見えないと
  // 「狙った位置に置けたか」を判断できない）。一度だけ描いてカメラ変換に任せる。
  drawGridLinesOnce(gridLineLayer, terrain.length, theme);

  const ROAD_W = 0.72; // 道幅（タイル単位）

  /** 前方4方向だけ見れば、隣接ペアごとに繋ぎが1回ずつ描かれる（右・右下・下・左下） */
  const FORWARD_DIRS: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];

  /**
   * 与えられたタイル集合を「繋がった1本の道」として描く。
   * タイル中心どうしを太線で結ぶので、直交も斜めも同じ仕組みで繋がり、交差も自然に出る。
   * プレビューと確定後の道路で共用し、仕上がりが事前に分かるようにする。
   */
  function paintConnected(
    g: Graphics,
    tiles: Array<{ x: number; y: number }>,
    has: (x: number, y: number) => boolean,
    color: number,
    alpha: number,
    ox = 0,
    oy = 0,
  ): void {
    // 端点と孤立タイルを丸く見せるための下地
    for (const t of tiles) {
      g.circle(t.x + 0.5 + ox, t.y + 0.5 + oy, ROAD_W / 2).fill({ color, alpha });
    }
    for (const t of tiles) {
      for (const [dx, dy] of FORWARD_DIRS) {
        if (!has(t.x + dx, t.y + dy)) continue;
        g.moveTo(t.x + 0.5 + ox, t.y + 0.5 + oy).lineTo(t.x + dx + 0.5 + ox, t.y + dy + 0.5 + oy);
        g.stroke({ width: ROAD_W, color, alpha, cap: 'round', join: 'round' });
      }
    }
  }

  function roadTiles(): Array<{ x: number; y: number }> {
    return net.tiles().map((id) => {
      const [xs, ys] = id.split(',');
      return { x: Number(xs), y: Number(ys) };
    });
  }

  function redrawRoads(): void {
    roadLayer.clear();
    roadShadowLayer.clear();
    const tiles = roadTiles();
    const has = (x: number, y: number) => net.has(x, y);
    paintConnected(roadShadowLayer, tiles, has, theme.shadow, theme.shadowAlpha, 0.04, 0.08);
    paintConnected(roadLayer, tiles, has, theme.road, 1);
  }
  redrawRoads();

  function setPreview(tiles: PreviewTile[]): void {
    previewLayer.clear();
    if (tiles.length === 0) return;
    // 確定後と同じ「繋がった道」の形で見せる（プレビューだけ別の形だと仕上がりが読めない）
    const keys = new Set(tiles.map((t) => `${t.x},${t.y}`));
    const has = (x: number, y: number) => keys.has(`${x},${y}`);
    paintConnected(
      previewLayer,
      tiles.filter((t) => t.valid),
      has,
      theme.preview,
      0.85,
    );
    paintConnected(
      previewLayer,
      tiles.filter((t) => !t.valid),
      has,
      theme.previewInvalid,
      0.85,
    );
  }

  function renderCars(views: CarView[]): void {
    carLayer.clear();
    carShadowLayer.clear();
    // 道幅より十分小さくする。大きいと道そのものが見えなくなる
    for (const v of views) {
      carShadowLayer
        .circle(v.x + 0.03, v.y + 0.05, 0.1)
        .fill({ color: theme.shadow, alpha: theme.shadowAlpha });
      const pts = carTrianglePoints(v.x, v.y, v.angle, 0.14);
      carLayer.poly(pts).fill(theme.vehicleCar);
    }
  }

  function applyCamera(cam: Camera): void {
    const w = app.renderer.width / app.renderer.resolution;
    const h = app.renderer.height / app.renderer.resolution;
    const s = tileScreenSize(cam);
    const origin = worldToScreen(cam, 0, 0, w, h);
    world.scale.set(s);
    world.position.set(origin.x, origin.y);
  }

  function drawGridLinesOnce(g: Graphics, size: number, th: Theme): void {
    // 線幅はワールド単位。world.scale が s 倍するので、ズーム1(=32px/タイル)で約1px になる
    const width = 0.03;
    for (let i = 0; i <= size; i++) {
      g.moveTo(i, 0).lineTo(i, size);
      g.moveTo(0, i).lineTo(size, i);
      g.stroke({ width, color: th.gridLine });
    }
  }

  return {
    app,
    setPreview,
    redrawRoads,
    renderCars,
    applyCamera,
    destroy() {
      app.destroy(true, { children: true });
    },
  };
}

/** 地形は固定（生成後に変わらない）ので、起動時に一度だけ描く */
function drawTerrainOnce(
  layer: Graphics,
  mountainShadow: Graphics,
  terrain: TileKind[][],
  theme: Theme,
): void {
  const size = terrain.length;
  for (let y = 0; y < size; y++) {
    const row = terrain[y];
    if (!row) continue;
    for (let x = 0; x < size; x++) {
      const kind = row[x];
      if (kind === 'water') {
        layer.rect(x, y, 1, 1).fill(theme.water);
      } else if (kind === 'mountain') {
        mountainShadow
          .rect(x + 0.08, y + 0.12, 1, 1)
          .fill({ color: theme.shadow, alpha: theme.shadowAlpha });
        layer.rect(x, y, 1, 1).fill(theme.mountain);
      }
      // 'plain' はアプリ背景色と同じなので描かずに済ませる（描画コスト削減）
    }
  }
}

/** 進行方向を向いた三角形（車の向き表現）。angle はラジアン */
function carTrianglePoints(cx: number, cy: number, angle: number, size: number): number[] {
  const back = size * 0.7;
  const spread = 2.4; // ラジアン。後方2点の開き角
  const tip = { x: cx + Math.cos(angle) * size, y: cy + Math.sin(angle) * size };
  const left = {
    x: cx + Math.cos(angle + spread) * back,
    y: cy + Math.sin(angle + spread) * back,
  };
  const right = {
    x: cx + Math.cos(angle - spread) * back,
    y: cy + Math.sin(angle - spread) * back,
  };
  return [tip.x, tip.y, left.x, left.y, right.x, right.y];
}
