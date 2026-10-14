import { describe, it, expect } from 'vitest';
import { riverAt } from './river';

/**
 * riverAt 単体のテスト。generateChunk を介さず、大域関数としての性質
 * （決定論・シード非依存の差異・毎行に必ず川の点が存在すること）を確認する。
 * チャンク境界をまたいだ連結の検証は index.test.ts 側で行う
 * （generateChunk と組み合わせた方がチャンク購入順非依存の意図に近いため）。
 */
describe('riverAt', () => {
  it('同一seed・同一座標で常に同じ結果になる', () => {
    for (const [seed, x, y] of [
      [1, 0, 0],
      [1, 5, -20],
      [42, -100, 300],
      [2026, 17, 17],
    ] as const) {
      const a = riverAt(seed, x, y);
      const b = riverAt(seed, x, y);
      expect(a).toBe(b);
    }
  });

  it('遠く離れた座標や負の座標でも例外を投げずに判定できる', () => {
    expect(() => riverAt(1, -1000, -1000)).not.toThrow();
    expect(() => riverAt(1, 100000, 100000)).not.toThrow();
  });

  it('seedが違えば川の位置も変わる（少なくとも1点は差が出る）', () => {
    let differs = false;
    for (let x = -32; x <= 32; x++) {
      if (riverAt(1, x, 0) !== riverAt(2, x, 0)) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  it('どの行 y にも中心点由来の川タイルが少なくとも1つは存在する（連結の前提）', () => {
    for (const seed of [1, 2, 3, 4, 99, 2026]) {
      for (const y of [-50, -1, 0, 1, 50, 1000]) {
        let found = false;
        for (let x = -40; x <= 40; x++) {
          if (riverAt(seed, x, y)) {
            found = true;
            break;
          }
        }
        expect(found, `seed=${seed}, y=${y} に川タイルが見つからない`).toBe(true);
      }
    }
  });
});
