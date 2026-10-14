import { describe, it, expect } from 'vitest';
import { createRng, next, nextInt, weightedPick, hashInts } from './rng';

describe('rng', () => {
  it('同一シードから同一列を再現する（決定論）', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 100 }, () => next(a));
    const seqB = Array.from({ length: 100 }, () => next(b));
    expect(seqA).toEqual(seqB);
  });

  it('異なるシードでは異なる列になる', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(next(a)).not.toBe(next(b));
  });

  it('状態を復元すると続きが一致する（セーブ/ロード相当）', () => {
    const a = createRng(999);
    for (let i = 0; i < 10; i++) next(a);
    const saved = a.state;
    const expected = Array.from({ length: 20 }, () => next(a));

    const restored = { state: saved };
    const actual = Array.from({ length: 20 }, () => next(restored));
    expect(actual).toEqual(expected);
  });

  it('next は [0, 1) に収まる', () => {
    const r = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = next(r);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('nextInt は [min, max) に収まる', () => {
    const r = createRng(42);
    for (let i = 0; i < 1000; i++) {
      const v = nextInt(r, 3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(9);
    }
  });

  it('weightedPick は重み0の要素を選ばない', () => {
    const r = createRng(5);
    for (let i = 0; i < 200; i++) {
      expect(weightedPick(r, [0, 1, 0])).toBe(1);
    }
  });

  it('weightedPick は全重み0で -1 を返す', () => {
    expect(weightedPick(createRng(1), [0, 0])).toBe(-1);
  });

  it('hashInts は引数順に依存し、同一入力で同一値', () => {
    expect(hashInts(1, 2)).toBe(hashInts(1, 2));
    expect(hashInts(1, 2)).not.toBe(hashInts(2, 1));
  });
});
