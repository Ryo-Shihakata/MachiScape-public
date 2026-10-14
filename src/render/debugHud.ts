/**
 * デバッグHUD（実装書 §17: M0から実機FPSを常時確認する）。
 * 開発ビルドでのみ表示する軽量なDOMオーバーレイ。
 */

export interface DebugHud {
  /** 毎フレーム呼ぶ。extra に任意の計測値を渡せる */
  update(extra?: Record<string, string | number>): void;
  destroy(): void;
}

export function createDebugHud(parent: HTMLElement): DebugHud {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:absolute',
    'top:env(safe-area-inset-top,0px)',
    'left:0',
    'padding:4px 8px',
    'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#fff',
    'background:rgba(0,0,0,0.55)',
    'pointer-events:none',
    'white-space:pre',
    'z-index:10',
  ].join(';');
  parent.appendChild(el);

  let frames = 0;
  let acc = 0;
  let fps = 0;
  let lastTs = performance.now();

  return {
    update(extra) {
      const now = performance.now();
      acc += now - lastTs;
      lastTs = now;
      frames++;
      if (acc >= 500) {
        fps = Math.round((frames * 1000) / acc);
        frames = 0;
        acc = 0;
      }
      let text = `${fps} fps`;
      if (extra) {
        for (const [k, v] of Object.entries(extra)) text += `\n${k}: ${v}`;
      }
      el.textContent = text;
    },
    destroy() {
      el.remove();
    },
  };
}
