/**
 * P0 自由曲線方式: 描画（依頼書 やること5）。
 * Pixi.js v8。フラットな単色図形 + ソフトシャドウ（計画書 §6）。色は必ず theme トークンから取る。
 */

import { Container, Graphics } from 'pixi.js';
import type { Theme } from '../../src/render/theme';
import type { TerrainKind } from './terrain';
import type { SplineNetwork } from './splineNetwork';
import type { CarView } from '../shared/dummyTraffic';

const ROAD_WIDTH = 0.42; // タイル単位
const ROAD_OUTLINE_EXTRA = 0.16;
const JUNCTION_RADIUS = 0.22;
const CAR_LENGTH = 0.34;
const CAR_WIDTH = 0.2;

export function buildTerrainLayer(grid: TerrainKind[][], theme: Theme): Container {
  const g = new Graphics();
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  for (let y = 0; y < h; y++) {
    const row = grid[y]!;
    for (let x = 0; x < row.length; x++) {
      const kind = row[x]!;
      const color = kind === 'water' ? theme.water : kind === 'mountain' ? theme.mountain : theme.background;
      g.rect(x, y, 1, 1).fill(color);
    }
  }
  // 薄いグリッド線（タイルの目安。曲線の道と対比させて見やすくする）
  for (let x = 0; x <= w; x++) g.moveTo(x, 0).lineTo(x, h);
  for (let y = 0; y <= h; y++) g.moveTo(0, y).lineTo(w, y);
  g.stroke({ width: 0.02, color: theme.gridLine, alpha: 0.6 });

  const layer = new Container();
  layer.addChild(g);
  return layer;
}

export function buildRoadLayer(net: SplineNetwork, theme: Theme): Container {
  const container = new Container();
  const nodes = net.nodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = net.edges();

  const outline = new Graphics();
  const fill = new Graphics();
  for (const e of edges) {
    const a = byId.get(e.a);
    const b = byId.get(e.b);
    if (!a || !b) continue;
    outline.moveTo(a.x, a.y).lineTo(b.x, b.y);
    fill.moveTo(a.x, a.y).lineTo(b.x, b.y);
  }
  if (edges.length > 0) {
    outline.stroke({ width: ROAD_WIDTH + ROAD_OUTLINE_EXTRA, color: theme.roadOutline, cap: 'round', join: 'round' });
    fill.stroke({ width: ROAD_WIDTH, color: theme.road, cap: 'round', join: 'round' });
  }
  container.addChild(outline, fill);

  // 分岐・交差点（次数3以上のノード）を丸で少し強調する
  const junctions = new Graphics();
  let hasJunction = false;
  for (const n of nodes) {
    if (net.neighbors(n.id).length >= 3) {
      junctions.circle(n.x, n.y, JUNCTION_RADIUS).fill(theme.road);
      hasJunction = true;
    }
  }
  if (hasJunction) container.addChild(junctions);

  return container;
}

export interface PreviewLayer {
  container: Container;
  setPoints(points: { x: number; y: number }[]): void;
}

export function buildPreviewLayer(theme: Theme): PreviewLayer {
  const g = new Graphics();
  const container = new Container();
  container.addChild(g);
  return {
    container,
    setPoints(points) {
      g.clear();
      if (points.length < 2) return;
      const first = points[0]!;
      g.moveTo(first.x, first.y);
      for (let i = 1; i < points.length; i++) {
        const p = points[i]!;
        g.lineTo(p.x, p.y);
      }
      g.stroke({ width: ROAD_WIDTH, color: theme.preview, cap: 'round', join: 'round', alpha: 0.85 });
    },
  };
}

export interface CarPool {
  container: Container;
  update(views: CarView[]): void;
}

export function createCarPool(theme: Theme, capacity: number): CarPool {
  const container = new Container();
  const bodies: Graphics[] = [];
  for (let i = 0; i < capacity; i++) {
    const body = new Graphics();
    // ソフトシャドウ（簡易: 車体の少し斜め下に半透明の楕円）
    body.ellipse(0.05, 0.06, CAR_LENGTH * 0.55, CAR_WIDTH * 0.55).fill({ color: theme.shadow, alpha: theme.shadowAlpha });
    body.roundRect(-CAR_LENGTH / 2, -CAR_WIDTH / 2, CAR_LENGTH, CAR_WIDTH, CAR_WIDTH * 0.4).fill(theme.vehicleCar);
    body.visible = false;
    bodies.push(body);
    container.addChild(body);
  }
  return {
    container,
    update(views) {
      for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i]!;
        const v = views[i];
        if (!v) {
          body.visible = false;
          continue;
        }
        body.visible = true;
        body.position.set(v.x, v.y);
        body.rotation = v.angle;
      }
    },
  };
}
