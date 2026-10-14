import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachPanZoom, createCamera, type PointerHandlers } from './camera';

class TestPointerEvent extends Event {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly button: number;

  constructor(
    type: string,
    init: { pointerId: number; clientX: number; clientY: number; button?: number },
  ) {
    super(type);
    this.pointerId = init.pointerId;
    this.clientX = init.clientX;
    this.clientY = init.clientY;
    this.button = init.button ?? 0;
  }
}

class TestElement extends EventTarget {
  readonly style: Record<string, string> = {};
  readonly clientWidth = 200;
  readonly clientHeight = 120;

  setPointerCapture(): void {}

  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0 } as DOMRect;
  }
}

function pointer(
  el: HTMLElement,
  type: string,
  pointerId: number,
  x: number,
  y: number,
  button = 0,
): void {
  el.dispatchEvent(new TestPointerEvent(type, { pointerId, clientX: x, clientY: y, button }));
}

function setup(overrides: Partial<PointerHandlers> = {}) {
  const el = new TestElement() as unknown as HTMLElement;
  const cam = createCamera();
  const handlers: PointerHandlers = {
    allowSinglePointerPan: () => false,
    ...overrides,
  };
  const detach = attachPanZoom(el, cam, handlers);
  return { el, cam, detach };
}

describe('attachPanZoom', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ツール操作の開始後に2本目が触れたら確定せず破棄する', () => {
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    const onDragCancel = vi.fn();
    const { el, detach } = setup({ onDragStart, onDragEnd, onDragCancel });

    pointer(el, 'pointerdown', 1, 40, 40);
    vi.advanceTimersByTime(90);
    pointer(el, 'pointerdown', 2, 80, 40);

    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(onDragCancel).toHaveBeenCalledTimes(1);
    detach();
  });

  it('ツール操作の保留中に2本目が触れたらタイマーごと破棄する', () => {
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    const onDragCancel = vi.fn();
    const { el, detach } = setup({ onDragStart, onDragEnd, onDragCancel });

    pointer(el, 'pointerdown', 1, 40, 40);
    pointer(el, 'pointerdown', 2, 80, 40);
    vi.advanceTimersByTime(90);

    expect(onDragStart).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(onDragCancel).toHaveBeenCalledTimes(1);
    detach();
  });

  it('6px未満かつ90ms未満の接触では建設を始めず確定もしない', () => {
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    const { el, detach } = setup({ onDragStart, onDragEnd });

    pointer(el, 'pointerdown', 1, 40, 40);
    vi.advanceTimersByTime(89);
    pointer(el, 'pointermove', 1, 45, 40);
    pointer(el, 'pointerup', 1, 45, 40);

    expect(onDragStart).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
    detach();
  });

  it('6px動くと start → move → end の順で建設ドラッグを通知する', () => {
    const calls: string[] = [];
    const { el, detach } = setup({
      onDragStart: () => calls.push('start'),
      onDragMove: () => calls.push('move'),
      onDragEnd: () => calls.push('end'),
    });

    pointer(el, 'pointerdown', 1, 40, 40);
    pointer(el, 'pointermove', 1, 46, 40);
    pointer(el, 'pointerup', 1, 46, 40);

    expect(calls).toEqual(['start', 'move', 'end']);
    detach();
  });

  it('動かず90ms押すと1タイルぶんの start → end を通知する', () => {
    const calls: string[] = [];
    const { el, detach } = setup({
      onDragStart: () => calls.push('start'),
      onDragMove: () => calls.push('move'),
      onDragEnd: () => calls.push('end'),
    });

    pointer(el, 'pointerdown', 1, 40, 40);
    vi.advanceTimersByTime(90);
    pointer(el, 'pointerup', 1, 40, 40);

    expect(calls).toEqual(['start', 'end']);
    detach();
  });

  it('中ボタンドラッグはツール選択中でもカメラだけを動かす', () => {
    const onPointerDown = vi.fn();
    const onDragStart = vi.fn();
    const onDragMove = vi.fn();
    const onDragEnd = vi.fn();
    const { el, cam, detach } = setup({ onPointerDown, onDragStart, onDragMove, onDragEnd });
    const before = { ...cam };

    pointer(el, 'pointerdown', 1, 40, 40, 1);
    pointer(el, 'pointermove', 1, 60, 40, 1);
    pointer(el, 'pointerup', 1, 60, 40, 1);

    expect(cam.x).not.toBe(before.x);
    expect(cam.y).toBe(before.y);
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onDragMove).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
    detach();
  });

  it('パン中でも長押し側が引き取った操作はカメラ移動やタップに流さない', () => {
    const onPointerDown = vi.fn();
    const onPointerMove = vi.fn(() => true);
    const onPointerUp = vi.fn(() => true);
    const onTap = vi.fn();
    const { el, cam, detach } = setup({
      allowSinglePointerPan: () => true,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onTap,
    });

    pointer(el, 'pointerdown', 1, 40, 40);
    pointer(el, 'pointermove', 1, 45, 40);
    pointer(el, 'pointerup', 1, 45, 40);

    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerMove).toHaveBeenCalledTimes(1);
    expect(onPointerUp).toHaveBeenCalledTimes(1);
    expect(cam).toEqual(createCamera());
    expect(onTap).not.toHaveBeenCalled();
    detach();
  });

  it('pointercancel は開始済みの建設ドラッグを確定せず破棄する', () => {
    const onDragEnd = vi.fn();
    const onDragCancel = vi.fn();
    const { el, detach } = setup({ onDragEnd, onDragCancel });

    pointer(el, 'pointerdown', 1, 40, 40);
    pointer(el, 'pointermove', 1, 46, 40);
    pointer(el, 'pointercancel', 1, 46, 40);

    expect(onDragEnd).not.toHaveBeenCalled();
    expect(onDragCancel).toHaveBeenCalledTimes(1);
    detach();
  });

  it('14px未満の揺れはパン操作のタップとして扱う', () => {
    const onTap = vi.fn();
    const { el, detach } = setup({ allowSinglePointerPan: () => true, onTap });

    pointer(el, 'pointerdown', 1, 40, 40);
    pointer(el, 'pointermove', 1, 50, 40);
    pointer(el, 'pointerup', 1, 50, 40);

    expect(onTap).toHaveBeenCalledTimes(1);
    detach();
  });
});
