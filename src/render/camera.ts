/**
 * カメラとポインタ入力（実装書 §12.3）。
 * P0 の3方式（グリッド / 自由曲線 / ヘックス）が共有する入力の土台。
 *
 * 操作規約:
 * - 2本指は常にパン + ピンチズーム（選択中のツールに関係なく）
 * - 中ボタンは常にパン
 * - 1本指は handlers.allowSinglePointerPan() が true のときだけパン。
 *   false のときは移動量か押下時間が閾値に達してからツール操作が始まる
 */

import { INPUT, SPACE } from '../sim/balance';

export interface Vec2 {
  x: number;
  y: number;
}

export interface Camera {
  /** ワールド座標（タイル単位）でのビュー中心 */
  x: number;
  y: number;
  zoom: number;
}

export function createCamera(x = 0, y = 0, zoom = 1): Camera {
  return { x, y, zoom };
}

/** 1タイルあたりの画面ピクセル数 */
export function tileScreenSize(cam: Camera): number {
  return SPACE.TILE_PX * cam.zoom;
}

/** 画面座標（要素内のCSSピクセル）→ ワールド座標（タイル単位・小数） */
export function screenToWorld(cam: Camera, sx: number, sy: number, w: number, h: number): Vec2 {
  const s = tileScreenSize(cam);
  return {
    x: cam.x + (sx - w / 2) / s,
    y: cam.y + (sy - h / 2) / s,
  };
}

/** ワールド座標 → 画面座標 */
export function worldToScreen(cam: Camera, wx: number, wy: number, w: number, h: number): Vec2 {
  const s = tileScreenSize(cam);
  return {
    x: (wx - cam.x) * s + w / 2,
    y: (wy - cam.y) * s + h / 2,
  };
}

/** ワールド座標 → タイル座標（整数・切り捨て） */
export function worldToTile(p: Vec2): { x: number; y: number } {
  return { x: Math.floor(p.x), y: Math.floor(p.y) };
}

export function clampZoom(z: number): number {
  return Math.min(SPACE.ZOOM_MAX, Math.max(SPACE.ZOOM_MIN, z));
}

/** 指定した画面位置を固定したままズームする（ピンチ・ホイール共通） */
export function zoomAt(
  cam: Camera,
  factor: number,
  sx: number,
  sy: number,
  w: number,
  h: number,
): void {
  const before = screenToWorld(cam, sx, sy, w, h);
  cam.zoom = clampZoom(cam.zoom * factor);
  const after = screenToWorld(cam, sx, sy, w, h);
  cam.x += before.x - after.x;
  cam.y += before.y - after.y;
}

export interface PointerHandlers {
  /** true を返す間、1本指ドラッグはパンになる（パンツール選択時） */
  allowSinglePointerPan(): boolean;
  /** 長押しなど、選択ツールに依存しない操作を押下時から追跡する */
  onPointerDown?(world: Vec2, screen: Vec2): void;
  /** true なら長押し等が操作を引き取り、通常のパン・ツールドラッグを抑止する */
  onPointerMove?(world: Vec2, screen: Vec2): boolean | void;
  /** true なら長押し等が確定済みなので、通常のタップ・ドラッグ確定を抑止する */
  onPointerUp?(world: Vec2, screen: Vec2): boolean | void;
  onPointerCancel?(): void;
  onDragStart?(world: Vec2): void;
  onDragMove?(world: Vec2): void;
  onDragEnd?(world: Vec2): void;
  onDragCancel?(): void;
  /** ドラッグ扱いにならなかった単発タップ */
  onTap?(world: Vec2): void;
}

/**
 * 要素にパン・ピンチズーム・ツールドラッグを接続する。
 * 戻り値を呼ぶと解除される。
 */
export function attachPanZoom(el: HTMLElement, cam: Camera, handlers: PointerHandlers): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let mode: 'none' | 'pan' | 'tool' | 'pinch' = 'none';
  let last: Vec2 = { x: 0, y: 0 };
  let pinchDist = 0;
  let downAt: Vec2 = { x: 0, y: 0 };
  let moved = false;
  let singleButton = -1;
  let toolStarted = false;
  let toolHoldTimer: ReturnType<typeof setTimeout> | null = null;

  const size = () => ({ w: el.clientWidth, h: el.clientHeight });
  const local = (ev: PointerEvent): Vec2 => {
    const r = el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const toWorld = (p: Vec2): Vec2 => {
    const { w, h } = size();
    return screenToWorld(cam, p.x, p.y, w, h);
  };

  const centerOf = (pts: { x: number; y: number }[]): Vec2 => {
    const sx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const sy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    return { x: sx, y: sy };
  };

  const clearToolHoldTimer = () => {
    if (toolHoldTimer === null) return;
    clearTimeout(toolHoldTimer);
    toolHoldTimer = null;
  };

  const startTool = () => {
    if (mode !== 'tool' || toolStarted) return;
    clearToolHoldTimer();
    toolStarted = true;
    handlers.onDragStart?.(toWorld(downAt));
  };

  const onPointerDown = (ev: PointerEvent) => {
    el.setPointerCapture(ev.pointerId);
    const p = local(ev);
    pointers.set(ev.pointerId, p);

    if (pointers.size === 2) {
      // ピンチへの移行を確定扱いにすると、地図を動かすたびに1本目の地点へ建設される
      if (singleButton === 0) handlers.onPointerCancel?.();
      if (mode === 'tool') handlers.onDragCancel?.();
      clearToolHoldTimer();
      toolStarted = false;
      singleButton = -1;
      const pts = [...pointers.values()];
      mode = 'pinch';
      last = centerOf(pts);
      pinchDist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      return;
    }
    if (pointers.size > 2) return;

    downAt = p;
    moved = false;
    last = p;
    singleButton = ev.button;
    toolStarted = false;
    if (singleButton === 0) handlers.onPointerDown?.(toWorld(p), p);
    // 中ボタンはツール選択に関係なく地図を逃がせる操作として常にパンを優先する
    if (singleButton === 1 || handlers.allowSinglePointerPan()) {
      mode = 'pan';
    } else {
      mode = 'tool';
      toolHoldTimer = setTimeout(startTool, INPUT.TOOL_HOLD_MS);
    }
  };

  const onPointerMove = (ev: PointerEvent) => {
    if (!pointers.has(ev.pointerId)) return;
    const p = local(ev);
    pointers.set(ev.pointerId, p);
    const { w, h } = size();

    if (mode === 'pinch' && pointers.size >= 2) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      const center = centerOf(pts);
      if (pinchDist > 0) zoomAt(cam, dist / pinchDist, center.x, center.y, w, h);
      pinchDist = dist;
      const s = tileScreenSize(cam);
      cam.x -= (center.x - last.x) / s;
      cam.y -= (center.y - last.y) / s;
      last = center;
      return;
    }

    const distance = Math.hypot(p.x - downAt.x, p.y - downAt.y);
    if (distance > INPUT.TAP_SLOP_PX) moved = true;

    if (singleButton === 0 && handlers.onPointerMove?.(toWorld(p), p) === true) {
      last = p;
      return;
    }

    if (mode === 'pan') {
      const s = tileScreenSize(cam);
      cam.x -= (p.x - last.x) / s;
      cam.y -= (p.y - last.y) / s;
      last = p;
    } else if (mode === 'tool') {
      last = p;
      if (!toolStarted && distance >= INPUT.TOOL_SLOP_PX) startTool();
      if (toolStarted) handlers.onDragMove?.(toWorld(p));
    }
  };

  const onPointerUp = (ev: PointerEvent) => {
    if (!pointers.has(ev.pointerId)) return;
    const p = local(ev);
    pointers.delete(ev.pointerId);

    if (mode === 'pinch') {
      // 1本残ったらパンへ引き継ぐ（ツールを誤発火させない）
      if (pointers.size === 1) {
        mode = 'pan';
        last = [...pointers.values()][0]!;
      } else {
        mode = 'none';
      }
      return;
    }

    const claimed = singleButton === 0 && handlers.onPointerUp?.(toWorld(p), p) === true;
    if (!claimed && mode === 'tool' && toolStarted) {
      handlers.onDragEnd?.(toWorld(p));
    } else if (!claimed && mode === 'pan' && singleButton === 0 && !moved) {
      handlers.onTap?.(toWorld(p));
    }
    clearToolHoldTimer();
    toolStarted = false;
    if (pointers.size === 0) {
      mode = 'none';
      singleButton = -1;
    }
  };

  const onPointerCancel = (ev: PointerEvent) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.delete(ev.pointerId);

    if (mode === 'pinch') {
      // ツール操作はピンチ開始時に既に破棄済み。残った指は誤発火しないパンへ送る
      if (pointers.size === 1) {
        mode = 'pan';
        last = [...pointers.values()][0]!;
      } else {
        mode = 'none';
      }
      return;
    }

    if (singleButton === 0) handlers.onPointerCancel?.();
    if (mode === 'tool') handlers.onDragCancel?.();
    clearToolHoldTimer();
    toolStarted = false;
    mode = 'none';
    singleButton = -1;
  };

  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const r = el.getBoundingClientRect();
    const { w, h } = size();
    zoomAt(cam, Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top, w, h);
  };

  const onContextMenu = (ev: Event) => ev.preventDefault();

  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerCancel);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', onContextMenu);

  return () => {
    clearToolHoldTimer();
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerCancel);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('contextmenu', onContextMenu);
  };
}
