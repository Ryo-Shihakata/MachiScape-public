import { describe, it, expect } from 'vitest';
import { generateChunk, generateStartChunk, riverAt } from './index';
import { MAPGEN, SPACE } from '../balance';
import { TERRAIN_CODE } from '../grid';

const CS = SPACE.CHUNK_SIZE;
const VALID_CODES = new Set(Object.values(TERRAIN_CODE));

describe('generateChunk: 決定論', () => {
  it('同一シード・同一チャンク座標で完全に同じ地形になる', () => {
    const a = generateChunk(12345, 2, -3);
    const b = generateChunk(12345, 2, -3);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('長さが CHUNK_SIZE*CHUNK_SIZE で、TERRAIN_CODE の値のみを含む', () => {
    const t = generateChunk(1, 0, 0);
    expect(t.length).toBe(CS * CS);
    for (const code of t) expect(VALID_CODES.has(code)).toBe(true);
  });

  it('シードが違えば地形も変わる', () => {
    const a = generateChunk(1, 5, 5);
    const b = generateChunk(2, 5, 5);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe('generateChunk: 生成順に依存しない', () => {
  it('(0,0)→(1,0) の順と (1,0)→(0,0) の順で (1,0) の地形が一致する', () => {
    const seed = 777;

    // (0,0) を先に生成してから (1,0) を生成する順
    generateChunk(seed, 0, 0);
    const orderA_10 = generateChunk(seed, 1, 0);

    // (1,0) を先に生成してから (0,0) を生成する順（逆順）
    const orderB_10 = generateChunk(seed, 1, 0);
    generateChunk(seed, 0, 0);

    expect(Array.from(orderA_10)).toEqual(Array.from(orderB_10));
  });

  it('負のチャンク座標を含む複数チャンクを異なる順で生成しても一致する', () => {
    const seed = 42;
    const coords: Array<[number, number]> = [
      [0, 0],
      [-1, 0],
      [0, -1],
      [3, -2],
    ];

    const forward = coords.map(([cx, cy]) => Array.from(generateChunk(seed, cx, cy)));
    const backward = [...coords]
      .reverse()
      .map(([cx, cy]) => Array.from(generateChunk(seed, cx, cy)));
    backward.reverse(); // 元の coords 順に並べ直して forward と突き合わせる

    expect(backward).toEqual(forward);
  });
});

describe('generateStartChunk: 開始チャンクの保証', () => {
  const seeds = [1, 2, 3, 42, 999, 123456, 7, 2026, 555, 8080];

  it.each(seeds)('平地率 ≥ 60%・川が通る (seed=%i)', (seed) => {
    const { seed: adoptedSeed, terrain } = generateStartChunk(seed);

    let plain = 0;
    for (const code of terrain) if (code === TERRAIN_CODE.plain) plain++;
    const ratio = plain / terrain.length;
    expect(ratio).toBeGreaterThanOrEqual(MAPGEN.START_CHUNK_MIN_PLAIN_RATIO);

    let hasRiver = false;
    for (let y = 0; y < CS && !hasRiver; y++) {
      for (let x = 0; x < CS; x++) {
        if (riverAt(adoptedSeed, x, y)) {
          hasRiver = true;
          break;
        }
      }
    }
    expect(hasRiver).toBe(true);

    // 採用した seed で generateChunk(0,0) を呼び直しても同じ地形になる（再現性）
    expect(Array.from(generateChunk(adoptedSeed, 0, 0))).toEqual(Array.from(terrain));
  });
});

describe('river: チャンク境界をまたいだ4近傍の連結', () => {
  const seeds = [1, 2, 3, 4, 99, 2026, 555];

  it.each(seeds)(
    '隣接する2チャンク(0,0)・(0,1)を生成し、境界(y=CS/CS-1)をまたいで川が繋がっている (seed=%i)',
    (seed) => {
      const chunkTop = generateChunk(seed, 0, 0);
      const chunkBottom = generateChunk(seed, 0, 1);

      // margin: 蛇行でxがチャンクのx範囲(0..CS-1)外に出ても拾えるようにする
      const margin = CS;
      const minX = -margin;
      const maxX = CS + margin;

      const seen = new Set<string>();
      const stack: Array<[number, number]> = [];
      for (let x = minX; x <= maxX; x++) {
        if (riverAt(seed, x, 0)) {
          stack.push([x, 0]);
          seen.add(`${x},0`);
        }
      }
      expect(stack.length, `seed=${seed}: y=0 に川タイルがない`).toBeGreaterThan(0);

      let reachedNextChunk = false; // y = CS（(0,1)の最初の行）に到達したか
      const dirs: Array<[number, number]> = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      while (stack.length > 0) {
        const [x, y] = stack.pop() as [number, number];
        if (y >= CS) reachedNextChunk = true;
        for (const [dx, dy] of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < minX || nx > maxX || ny < 0 || ny >= CS * 2) continue;
          const k = `${nx},${ny}`;
          if (seen.has(k)) continue;
          if (!riverAt(seed, nx, ny)) continue;
          seen.add(k);
          stack.push([nx, ny]);
        }
      }
      expect(
        reachedNextChunk,
        `seed=${seed}: 川がチャンク境界(y=${CS})をまたいで連結していない`,
      ).toBe(true);

      // generateChunk が実際に riverAt と同じ座標を水タイルとしてマークしているかも確認する
      // （優先順位1=川が、山・森のノイズに上書きされていないこと）
      for (const key of seen) {
        const [xStr, yStr] = key.split(',');
        const x = Number(xStr);
        const y = Number(yStr);
        if (x < 0 || x >= CS) continue; // このチャンクのx範囲外は対象外
        const arr = y < CS ? chunkTop : chunkBottom;
        const ly = y < CS ? y : y - CS;
        expect(arr[ly * CS + x], `(${x},${y}) は riverAt=true だが terrain が水でない`).toBe(
          TERRAIN_CODE.water,
        );
      }
    },
  );
});
