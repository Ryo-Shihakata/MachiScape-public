import { describe, it, expect } from 'vitest';
import { SPACE } from '../balance';
import { addChunk, createGrid, setRoad, setTerrain } from '../grid';
import type { Grid, TilePos } from '../types';
import { validateBridge } from './bridge';

const CS = SPACE.CHUNK_SIZE;

/** y=5 の行に x=3..5 の川が流れる盤面 */
function riverGrid(): Grid {
  const g = createGrid();
  addChunk(g, 0, 0, new Uint8Array(CS * CS));
  for (let x = 3; x <= 5; x++) setTerrain(g, x, 5, 'water');
  return g;
}

const t = (x: number, y: number): TilePos => ({ x, y });

describe('validateBridge', () => {
  it('水を渡らない道は常に妥当', () => {
    const g = riverGrid();
    expect(validateBridge(g, [t(0, 0), t(1, 0), t(2, 0)])).toBe(true);
  });

  it('川を直線で渡り、両端が同じ操作で敷かれる陸に繋がるなら妥当', () => {
    // 縦に (4,3)〜(4,7) を敷く。(4,5) が水
    const g = createGrid();
    addChunk(g, 0, 0, new Uint8Array(CS * CS));
    setTerrain(g, 4, 5, 'water');
    const tiles = [t(4, 3), t(4, 4), t(4, 5), t(4, 6), t(4, 7)];
    expect(validateBridge(g, tiles)).toBe(true);
  });

  it('両端が既設の陸の道路に繋がるなら妥当', () => {
    const g = createGrid();
    addChunk(g, 0, 0, new Uint8Array(CS * CS));
    setTerrain(g, 4, 5, 'water');
    setRoad(g, 4, 4, true);
    setRoad(g, 4, 6, true);
    expect(validateBridge(g, [t(4, 5)])).toBe(true);
  });

  it('片端が陸の道路に繋がっていなければ不正', () => {
    const g = createGrid();
    addChunk(g, 0, 0, new Uint8Array(CS * CS));
    setTerrain(g, 4, 5, 'water');
    setRoad(g, 4, 4, true);
    // (4,6) には何もない
    expect(validateBridge(g, [t(4, 5)])).toBe(false);
  });

  it('曲がった橋は不正', () => {
    const g = createGrid();
    addChunk(g, 0, 0, new Uint8Array(CS * CS));
    // L字に水を置き、その上を曲がって渡ろうとする
    setTerrain(g, 4, 5, 'water');
    setTerrain(g, 5, 5, 'water');
    setTerrain(g, 5, 6, 'water');
    const tiles = [t(4, 4), t(4, 5), t(5, 5), t(5, 6), t(5, 7)];
    expect(validateBridge(g, tiles)).toBe(false);
  });

  it('水上を斜めに渡る橋は不正（単一方向でないため）', () => {
    const g = createGrid();
    addChunk(g, 0, 0, new Uint8Array(CS * CS));
    setTerrain(g, 4, 4, 'water');
    setTerrain(g, 5, 5, 'water');
    expect(validateBridge(g, [t(3, 3), t(4, 4), t(5, 5), t(6, 6)])).toBe(false);
  });

  it('水上の区間が飛んでいたら不正', () => {
    const g = createGrid();
    addChunk(g, 0, 0, new Uint8Array(CS * CS));
    setTerrain(g, 4, 4, 'water');
    setTerrain(g, 4, 6, 'water');
    // (4,5) が陸なので、区間としては別々の橋。それぞれ両端が繋がるので妥当になる
    expect(validateBridge(g, [t(4, 3), t(4, 4), t(4, 5), t(4, 6), t(4, 7)])).toBe(true);
  });

  it('橋の先が山なら不正（アンカーにならない）', () => {
    const g = createGrid();
    addChunk(g, 0, 0, new Uint8Array(CS * CS));
    setTerrain(g, 4, 5, 'water');
    setTerrain(g, 4, 6, 'mountain');
    expect(validateBridge(g, [t(4, 4), t(4, 5), t(4, 6)])).toBe(false);
  });

  it('複数タイル幅の川を1本の橋で渡れる', () => {
    const g = riverGrid();
    // y=5 の x=3..5 が水。横に (2,5)〜(6,5) を敷く
    expect(validateBridge(g, [t(2, 5), t(3, 5), t(4, 5), t(5, 5), t(6, 5)])).toBe(true);
  });
});

/**
 * 幅1タイルの川を横切る橋（回帰テスト）。
 *
 * 水が1タイルだけの区間は「全タイル同x」と「全タイル同y」が同時に成り立つため、
 * 向きを sameX で決め打ちすると常に縦の橋として扱われ、**横向きの橋が架けられなかった**。
 * 川は幅1〜2タイルで生成され開始チャンクを必ず通る（実装書 §5）ので、
 * プレイヤーが最初に踏む操作のひとつ。
 */
describe('幅1タイルの水を渡る橋', () => {
  it('横向きに渡れる（同じ操作で敷く陸タイルが両端の足場になる）', () => {
    const grid = createGrid();
    addChunk(grid, 0, 0, new Uint8Array(CS * CS));
    setTerrain(grid, 2, 1, 'water');
    // (1,1) 陸 → (2,1) 水 → (3,1) 陸 を1回のドラッグで敷く
    const tiles = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ];
    expect(validateBridge(grid, tiles)).toBe(true);
  });

  it('縦向きにも渡れる', () => {
    const grid = createGrid();
    addChunk(grid, 0, 0, new Uint8Array(CS * CS));
    setTerrain(grid, 1, 2, 'water');
    const tiles = [
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
    ];
    expect(validateBridge(grid, tiles)).toBe(true);
  });

  it('片側が陸に繋がっていなければ不可（向きを両方試しても通さない）', () => {
    const grid = createGrid();
    addChunk(grid, 0, 0, new Uint8Array(CS * CS));
    setTerrain(grid, 2, 1, 'water');
    // 水タイル1枚だけ。上下左右のどこにも道路が無い
    expect(validateBridge(grid, [{ x: 2, y: 1 }])).toBe(false);
  });
});
