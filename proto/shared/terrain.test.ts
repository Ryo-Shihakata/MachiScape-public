import { describe, it, expect } from 'vitest';
import {
  PROTO_MAP_SEED,
  PROTO_MAP_SIZE,
  canBuildRoadOn,
  generateProtoTerrain,
  terrainAtWorld,
} from './terrain';

/**
 * この地形は「3方式が同じマップの上で比較できる」ことを担保するためのもの。
 * D1 の判断が空間モデルではなく地形の当たり外れで決まってしまわないよう、
 * 生成の性質をここで固定する。
 */
describe('proto terrain', () => {
  it('同一シードで完全に同じ地形になる（3方式が同じマップを見る前提）', () => {
    const a = generateProtoTerrain(PROTO_MAP_SIZE, PROTO_MAP_SEED);
    const b = generateProtoTerrain(PROTO_MAP_SIZE, PROTO_MAP_SEED);
    expect(a).toEqual(b);
  });

  it('シードが違えば地形も変わる', () => {
    const a = generateProtoTerrain(PROTO_MAP_SIZE, 1);
    const b = generateProtoTerrain(PROTO_MAP_SIZE, 2);
    expect(a).not.toEqual(b);
  });

  it('どのシードでも建設可能な平地が十分に残る', () => {
    for (const seed of [PROTO_MAP_SEED, 1, 2, 3, 4, 99]) {
      const f = generateProtoTerrain(PROTO_MAP_SIZE, seed);
      let mountain = 0;
      for (const row of f) for (const t of row) if (t === 'mountain') mountain++;
      const ratio = mountain / (PROTO_MAP_SIZE * PROTO_MAP_SIZE);
      // 分位点で決めているので、シードによらず一定の割合に収まる
      expect(ratio).toBeGreaterThan(0.1);
      expect(ratio).toBeLessThan(0.22);
    }
  });

  // 「各行に水がある」だけでは (x,y) と (x+1,y+1) の角接続を見逃す。
  // 角でしか接していない川は見た目が分断されるので、4近傍の連結を検証する。
  it.each([PROTO_MAP_SEED, 1, 2, 3, 4, 99])(
    '川が上端から下端まで4近傍で連結している (seed=%i)',
    (seed) => {
      const f = generateProtoTerrain(PROTO_MAP_SIZE, seed);
      const seen = new Set<string>();
      const stack: Array<[number, number]> = [];
      (f[0] ?? []).forEach((t, x) => {
        if (t === 'water') {
          stack.push([x, 0]);
          seen.add(`${x},0`);
        }
      });
      expect(stack.length, '上端に川がない').toBeGreaterThan(0);

      let reachedBottom = false;
      while (stack.length > 0) {
        const [x, y] = stack.pop() as [number, number];
        if (y === PROTO_MAP_SIZE - 1) reachedBottom = true;
        const dirs: Array<[number, number]> = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ];
        for (const [dx, dy] of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          const k = `${nx},${ny}`;
          if (seen.has(k)) continue;
          if (f[ny]?.[nx] !== 'water') continue;
          seen.add(k);
          stack.push([nx, ny]);
        }
      }
      expect(reachedBottom, '川が上端から下端まで繋がっていない（角接続で分断）').toBe(true);
    },
  );

  it('範囲外は建設不可として扱う（ヘックスのサンプリングが場外に出たとき用）', () => {
    const f = generateProtoTerrain(PROTO_MAP_SIZE, PROTO_MAP_SEED);
    expect(terrainAtWorld(f, -1, 0)).toBe('mountain');
    expect(terrainAtWorld(f, 0, PROTO_MAP_SIZE + 5)).toBe('mountain');
    expect(canBuildRoadOn(terrainAtWorld(f, -1, 0))).toBe(false);
  });

  it('山だけが建設不可（水は橋として許可）', () => {
    expect(canBuildRoadOn('plain')).toBe(true);
    expect(canBuildRoadOn('water')).toBe(true);
    expect(canBuildRoadOn('mountain')).toBe(false);
  });
});
