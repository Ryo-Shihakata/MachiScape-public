import { describe, it, expect } from 'vitest';
import { SPACE, TRAFFIC } from '../balance';
import { addChunk, createGrid, setRoad, setRoadRank } from '../grid';
import type { Grid, TilePos } from '../types';
import { createCongestionMap, updateCongestion, congestionAt } from './congestion';
import { findPath, octile } from './pathfind';

const CS = SPACE.CHUNK_SIZE;

function gridWith(roads: Array<[number, number]>): Grid {
  const g = createGrid();
  addChunk(g, 0, 0, new Uint8Array(CS * CS));
  addChunk(g, 1, 0, new Uint8Array(CS * CS));
  for (const [x, y] of roads) setRoad(g, x, y, true);
  return g;
}

const line = (x0: number, y0: number, dx: number, dy: number, n: number): Array<[number, number]> =>
  Array.from({ length: n }, (_, i) => [x0 + dx * i, y0 + dy * i] as [number, number]);

describe('findPath', () => {
  it('直線の最短経路を返す', () => {
    const g = gridWith(line(0, 0, 1, 0, 5));
    const path = findPath(g, createCongestionMap(), { x: 0, y: 0 }, { x: 4, y: 0 });
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
    ]);
  });

  it('L字の経路を返す', () => {
    const g = gridWith([...line(0, 0, 1, 0, 4), ...line(3, 0, 0, 1, 4)]);
    const path = findPath(g, createCongestionMap(), { x: 0, y: 0 }, { x: 3, y: 3 });
    expect(path).not.toBeNull();
    expect(path?.[0]).toEqual({ x: 0, y: 0 });
    expect(path?.[path.length - 1]).toEqual({ x: 3, y: 3 });
  });

  it('斜めに並んだ道路でも経路が見つかる（8方向接続・D3）', () => {
    const g = gridWith(line(0, 0, 1, 1, 5));
    const path = findPath(g, createCongestionMap(), { x: 0, y: 0 }, { x: 4, y: 4 });
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 4, y: 4 },
    ]);
  });

  it('道路が分断されていれば null', () => {
    const g = gridWith([...line(0, 0, 1, 0, 3), ...line(6, 0, 1, 0, 3)]);
    expect(findPath(g, createCongestionMap(), { x: 0, y: 0 }, { x: 8, y: 0 })).toBeNull();
  });

  it('始点・終点が道路でなければ null', () => {
    const g = gridWith(line(0, 0, 1, 0, 3));
    expect(findPath(g, createCongestionMap(), { x: 0, y: 0 }, { x: 5, y: 5 })).toBeNull();
    expect(findPath(g, createCongestionMap(), { x: 5, y: 5 }, { x: 0, y: 0 })).toBeNull();
  });

  it('世界の外へは進めない', () => {
    const g = createGrid();
    addChunk(g, 0, 0, new Uint8Array(CS * CS));
    setRoad(g, CS - 1, 0, true);
    // 隣チャンクは未解放なので道路も置けない
    setRoad(g, CS, 0, true);
    expect(findPath(g, createCongestionMap(), { x: CS - 1, y: 0 }, { x: CS, y: 0 })).toBeNull();
  });

  it('斜めのコストは √2（階段状の道では斜め1手が直交2手より安い）', () => {
    // 斜めが許されるのは「共有する直交隣接がどちらも道路でない」ときだけ
    // （`sim/road/connectivity.ts`）。ここは (1,0) も (0,1) も道路が無い純粋な階段。
    const g = gridWith([
      [0, 0],
      [1, 1],
    ]);
    const path = findPath(g, createCongestionMap(), { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(path).toHaveLength(2); // 斜め1手で行く

    // まっすぐ2タイル進む場合は斜め迂回より直進が安い
    const g2 = gridWith([...line(0, 0, 1, 0, 3), [1, 1]]);
    const p2 = findPath(g2, createCongestionMap(), { x: 0, y: 0 }, { x: 2, y: 0 });
    expect(p2).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  /**
   * 斜め接続の規則（`sim/road/connectivity.ts`）。
   * **描画と同じ規則を経路探索も使う**ことで、「画面に無い斜めのショートカットを車が走る」
   * を防ぐ。十字路が菱形に描かれていたのはこの規則が無かったため。
   */
  describe('斜め接続の規則', () => {
    it('十字路では腕どうしの斜めを通らず、交差点を経由する', () => {
      // 中心(1,1)と四方の腕。腕どうし（例: (1,0) と (0,1)）は互いに斜め隣接だが、
      // 共有する直交隣接に中心(1,1)があるので斜めは通れない
      const g = gridWith([
        [1, 0],
        [0, 1],
        [1, 1],
        [2, 1],
        [1, 2],
      ]);
      const path = findPath(g, createCongestionMap(), { x: 1, y: 0 }, { x: 0, y: 1 });
      expect(path).toEqual([
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ]);
    });

    it('2×2の塊では斜めに突っ切らず直交で回る', () => {
      const g = gridWith([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]);
      const path = findPath(g, createCongestionMap(), { x: 0, y: 0 }, { x: 1, y: 1 });
      expect(path).toHaveLength(3);
    });

    it('斜めを落としても到達できなくなる場所は生まれない', () => {
      // 斜めが落ちるのは共有する直交隣接のどちらかが道路のときだけで、
      // そのときは必ず「直交2手」の代替がある
      const g = gridWith([
        [0, 0],
        [1, 0],
        [1, 1],
        [2, 2],
      ]);
      // (1,1)→(2,2) は純粋な斜めなので通れる。全体として端から端まで到達できる
      expect(findPath(g, createCongestionMap(), { x: 0, y: 0 }, { x: 2, y: 2 })).not.toBeNull();
    });
  });

  it('混雑した経路を避けて迂回する', () => {
    // 上ルート(y=0)は短い、下ルート(y=2)は1タイル長い
    const roads: Array<[number, number]> = [
      ...line(0, 0, 1, 0, 5), // 上
      [0, 1],
      [0, 2],
      ...line(0, 2, 1, 0, 5), // 下
      [4, 1],
    ];
    const g = gridWith(roads);
    const cong = createCongestionMap();
    const from = { x: 0, y: 0 };
    const to = { x: 4, y: 0 };

    const before = findPath(g, cong, from, to);
    expect(before?.every((p: TilePos) => p.y === 0)).toBe(true); // 空いていれば上を直進

    // 上ルートを渋滞させる
    const occ: Record<string, number> = {};
    for (let x = 1; x <= 3; x++) occ[`${x},0`] = 100;
    for (let i = 0; i < 200; i++) updateCongestion(cong, occ);
    expect(congestionAt(cong, 2, 0)).toBeGreaterThan(0.9);

    const after = findPath(g, cong, from, to);
    expect(after?.some((p: TilePos) => p.y === 2)).toBe(true); // 下へ迂回する
  });

  it('同じ在車数なら容量の大きい幹線の混雑度が低くなり、A*が自然に選ぶ', () => {
    const roads: Array<[number, number]> = [
      [0, 1],
      [4, 1],
      ...line(0, 0, 1, 0, 5),
      ...line(0, 2, 1, 0, 5),
      [0, 0],
      [0, 2],
      [4, 0],
      [4, 2],
    ];
    const g = gridWith(roads);
    for (let x = 1; x <= 3; x++) setRoadRank(g, x, 2, 2);
    const congestion = createCongestionMap();
    const occupancy: Record<string, number> = {};
    for (let x = 1; x <= 3; x++) {
      occupancy[`${x},0`] = TRAFFIC.CAPACITY;
      occupancy[`${x},2`] = TRAFFIC.CAPACITY;
    }
    for (let i = 0; i < 200; i++) updateCongestion(congestion, occupancy, g);

    expect(congestionAt(congestion, 2, 2)).toBeLessThan(congestionAt(congestion, 2, 0));
    const path = findPath(g, congestion, { x: 0, y: 1 }, { x: 4, y: 1 });
    expect(path?.some((tile) => tile.y === 2)).toBe(true);
  });

  it('決定論: 同じ入力で100回とも同じ経路を返す', () => {
    // 対称で同コストの経路が多数ある盤面（タイブレークが効かないと揺れる）
    const roads: Array<[number, number]> = [];
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) roads.push([x, y]);
    const g = gridWith(roads);
    const cong = createCongestionMap();
    const first = findPath(g, cong, { x: 0, y: 0 }, { x: 5, y: 5 });
    for (let i = 0; i < 100; i++) {
      expect(findPath(g, cong, { x: 0, y: 0 }, { x: 5, y: 5 })).toEqual(first);
    }
  });

  it('始点と終点が同じなら1タイルの経路', () => {
    const g = gridWith([[3, 3]]);
    expect(findPath(g, createCongestionMap(), { x: 3, y: 3 }, { x: 3, y: 3 })).toEqual([
      { x: 3, y: 3 },
    ]);
  });

  it('チャンクをまたいで経路が繋がる', () => {
    const g = gridWith(line(CS - 3, 5, 1, 0, 6));
    const path = findPath(g, createCongestionMap(), { x: CS - 3, y: 5 }, { x: CS + 2, y: 5 });
    expect(path).toHaveLength(6);
  });
});

describe('octile', () => {
  it('直交距離はそのまま、斜めは√2倍で数える', () => {
    expect(octile({ x: 0, y: 0 }, { x: 3, y: 0 })).toBeCloseTo(3);
    expect(octile({ x: 0, y: 0 }, { x: 3, y: 3 })).toBeCloseTo(3 * Math.SQRT2);
  });

  it('実コストを超えない（許容的である）', () => {
    // 8方向の実最短コストは max(dx,dy) + (√2-1)*min(dx,dy) に等しい
    for (const [dx, dy] of [
      [5, 2],
      [2, 5],
      [7, 7],
      [0, 4],
    ]) {
      const h = octile({ x: 0, y: 0 }, { x: dx as number, y: dy as number });
      const real =
        Math.max(dx as number, dy as number) +
        (Math.SQRT2 - 1) * Math.min(dx as number, dy as number);
      expect(h).toBeLessThanOrEqual(real + 1e-9);
    }
  });
});

describe('congestion', () => {
  it('占有がなくなると減衰し、最終的にエントリが消える', () => {
    const cong = createCongestionMap();
    const occ = { '1,1': 100 };
    for (let i = 0; i < 200; i++) updateCongestion(cong, occ);
    expect(congestionAt(cong, 1, 1)).toBeGreaterThan(0.9);

    for (let i = 0; i < 500; i++) updateCongestion(cong, {});
    expect(congestionAt(cong, 1, 1)).toBe(0);
    expect(Object.keys(cong)).toHaveLength(0);
  });

  it('混雑度は0..1に収まる', () => {
    const cong = createCongestionMap();
    for (let i = 0; i < 500; i++) updateCongestion(cong, { '2,2': 9999 });
    expect(congestionAt(cong, 2, 2)).toBeLessThanOrEqual(1);
    expect(congestionAt(cong, 2, 2)).toBeGreaterThan(0);
  });
});
