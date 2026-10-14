/**
 * M0: 空のグリッド描画。カメラに追従してビューポート内だけを描く。
 * P0 で空間モデルが確定したら、この描画は選ばれた方式のものに置き換える。
 */

import { Application, Container, Graphics } from 'pixi.js';
import { SPACE } from '../sim/balance';
import type { Camera } from './camera';
import { tileScreenSize, worldToScreen } from './camera';
import type { Theme } from './theme';

export interface GridScene {
  app: Application;
  /** カメラの現在値でグリッドを描き直す */
  draw(cam: Camera, theme: Theme): void;
  destroy(): void;
}

export async function createGridScene(host: HTMLElement, theme: Theme): Promise<GridScene> {
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

  const layer = new Container();
  const lines = new Graphics();
  layer.addChild(lines);
  app.stage.addChild(layer);

  function draw(cam: Camera, th: Theme): void {
    const w = app.renderer.width / app.renderer.resolution;
    const h = app.renderer.height / app.renderer.resolution;
    const s = tileScreenSize(cam);
    lines.clear();

    // ズームアウトしすぎたらタイル線を省き、チャンク線だけ描く（描画負荷の上限を切る）
    const drawTileLines = s >= 8;
    const step = drawTileLines ? 1 : SPACE.CHUNK_SIZE;

    const x0 = Math.floor(cam.x - w / 2 / s / step) * step - step;
    const x1 = Math.ceil(cam.x + w / 2 / s / step) * step + step;
    const y0 = Math.floor(cam.y - h / 2 / s / step) * step - step;
    const y1 = Math.ceil(cam.y + h / 2 / s / step) * step + step;

    for (let x = x0; x <= x1; x += step) {
      const p = worldToScreen(cam, x, y0, w, h);
      const q = worldToScreen(cam, x, y1, w, h);
      const strong = x % SPACE.CHUNK_SIZE === 0;
      lines.moveTo(p.x, p.y).lineTo(q.x, q.y);
      lines.stroke({ width: strong ? 1.5 : 1, color: strong ? th.gridLineStrong : th.gridLine });
    }
    for (let y = y0; y <= y1; y += step) {
      const p = worldToScreen(cam, x0, y, w, h);
      const q = worldToScreen(cam, x1, y, w, h);
      const strong = y % SPACE.CHUNK_SIZE === 0;
      lines.moveTo(p.x, p.y).lineTo(q.x, q.y);
      lines.stroke({ width: strong ? 1.5 : 1, color: strong ? th.gridLineStrong : th.gridLine });
    }
  }

  draw({ x: 0, y: 0, zoom: 1 }, theme);

  return {
    app,
    draw,
    destroy() {
      app.destroy(true, { children: true });
    },
  };
}
