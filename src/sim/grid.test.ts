import { describe, it, expect } from 'vitest';
import { SPACE } from './balance';
import {
  addChunk,
  createGrid,
  hasChunk,
  hasRoad,
  hasRoadAccess,
  isInsideWorld,
  manhattan,
  roadRankAt,
  setRoad,
  setRoadRank,
  setTerrain,
  setZone,
  terrainAt,
  toChunk,
  zoneAt,
} from './grid';

const CS = SPACE.CHUNK_SIZE;
const emptyChunk = () => new Uint8Array(CS * CS);

describe('grid', () => {
  it('負の座標でもチャンクを正しく下方向へ丸める', () => {
    expect(toChunk(0, 0)).toEqual({ cx: 0, cy: 0 });
    expect(toChunk(CS - 1, CS - 1)).toEqual({ cx: 0, cy: 0 });
    expect(toChunk(CS, CS)).toEqual({ cx: 1, cy: 1 });
    expect(toChunk(-1, -1)).toEqual({ cx: -1, cy: -1 });
    expect(toChunk(-CS, -CS)).toEqual({ cx: -1, cy: -1 });
    expect(toChunk(-CS - 1, -CS - 1)).toEqual({ cx: -2, cy: -2 });
  });

  it('未解放チャンクは世界の外として扱う', () => {
    const g = createGrid();
    expect(isInsideWorld(g, 5, 5)).toBe(false);
    expect(terrainAt(g, 5, 5)).toBeUndefined();
    expect(hasRoad(g, 5, 5)).toBe(false);
    addChunk(g, 0, 0, emptyChunk());
    expect(isInsideWorld(g, 5, 5)).toBe(true);
    expect(isInsideWorld(g, CS + 5, 5)).toBe(false);
  });

  it('未解放チャンクへの書き込みは無視される（世界の外を汚さない）', () => {
    const g = createGrid();
    setRoad(g, 100, 100, true);
    expect(hasRoad(g, 100, 100)).toBe(false);
  });

  it('負の座標のチャンクでも読み書きが一致する', () => {
    const g = createGrid();
    addChunk(g, -1, -1, emptyChunk());
    setRoad(g, -1, -1, true);
    setTerrain(g, -5, -7, 'water');
    setZone(g, -3, -3, 'commercial');
    expect(hasRoad(g, -1, -1)).toBe(true);
    expect(terrainAt(g, -5, -7)).toBe('water');
    expect(zoneAt(g, -3, -3)).toBe('commercial');
    // 隣のタイルに漏れていないこと
    expect(hasRoad(g, -2, -1)).toBe(false);
  });

  it('同じチャンクを二重に追加しても地形が作り直されない', () => {
    const g = createGrid();
    addChunk(g, 0, 0, emptyChunk());
    setTerrain(g, 1, 1, 'mountain');
    addChunk(g, 0, 0, emptyChunk());
    expect(terrainAt(g, 1, 1)).toBe('mountain');
  });

  it('サイズの合わないチャンクは受け付けない', () => {
    const g = createGrid();
    expect(() => addChunk(g, 0, 0, new Uint8Array(4))).toThrow();
  });

  it('チャンク境界をまたいで道路が読める', () => {
    const g = createGrid();
    addChunk(g, 0, 0, emptyChunk());
    addChunk(g, 1, 0, emptyChunk());
    setRoad(g, CS - 1, 3, true);
    setRoad(g, CS, 3, true);
    expect(hasRoad(g, CS - 1, 3)).toBe(true);
    expect(hasRoad(g, CS, 3)).toBe(true);
  });

  it('道路ランクを同じ Uint8Array に0/1/2で保持する', () => {
    const g = createGrid();
    addChunk(g, 0, 0, emptyChunk());
    setRoad(g, 3, 4, true);
    setRoadRank(g, 5, 6, 2);
    expect(roadRankAt(g, 3, 4)).toBe(1);
    expect(roadRankAt(g, 5, 6)).toBe(2);
    expect(hasRoad(g, 5, 6)).toBe(true);
    expect(g.road['0,0']).toBeInstanceOf(Uint8Array);
  });

  it('道路アクセスはマンハッタン距離で判定する', () => {
    const g = createGrid();
    addChunk(g, 0, 0, emptyChunk());
    setRoad(g, 10, 10, true);
    expect(hasRoadAccess(g, 10, 12, 2)).toBe(true); // 距離2
    expect(hasRoadAccess(g, 11, 11, 2)).toBe(true); // 距離2（斜め）
    expect(hasRoadAccess(g, 10, 13, 2)).toBe(false); // 距離3
    expect(hasRoadAccess(g, 12, 12, 2)).toBe(false); // 距離4
  });

  it('manhattan が対称', () => {
    expect(manhattan({ x: 1, y: 2 }, { x: 4, y: 6 })).toBe(7);
    expect(manhattan({ x: 4, y: 6 }, { x: 1, y: 2 })).toBe(7);
  });

  it('hasChunk が解放状態を反映する', () => {
    const g = createGrid();
    expect(hasChunk(g, 0, 0)).toBe(false);
    addChunk(g, 0, 0, emptyChunk());
    expect(hasChunk(g, 0, 0)).toBe(true);
  });
});
