import { describe, it, expect } from 'vitest';
import { SPACE } from '../balance';
import { addChunk, createGrid, setRoad } from '../grid';
import { createCongestionMap } from './congestion';
import { findPath } from './pathfind';

const CS = SPACE.CHUNK_SIZE;

/**
 * 性能の目安（実装書 §17: シミュ1tick ≤ 5ms、車両1500）。
 * CI マシンの速度に左右されるので、閾値は「明らかに壊れたら落ちる」水準に置く。
 * 正確な計測は実機で行う（ここは回帰検知が目的）。
 */
describe('findPath の性能', () => {
  it('64x64の格子状道路で経路探索1回が十分速い', () => {
    const g = createGrid();
    for (let cx = 0; cx < 2; cx++) {
      for (let cy = 0; cy < 2; cy++) addChunk(g, cx, cy, new Uint8Array(CS * CS));
    }
    // 4タイルおきの格子状道路（現実の街に近い密度）
    const size = CS * 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (x % 4 === 0 || y % 4 === 0) setRoad(g, x, y, true);
      }
    }
    const cong = createCongestionMap();

    // ウォームアップ（JITの影響を避ける）
    for (let i = 0; i < 20; i++) findPath(g, cong, { x: 0, y: 0 }, { x: size - 4, y: size - 4 });

    const N = 100;
    const start = Date.now();
    for (let i = 0; i < N; i++) {
      const path = findPath(g, cong, { x: 0, y: 0 }, { x: size - 4, y: size - 4 });
      expect(path).not.toBeNull();
    }
    const perCall = (Date.now() - start) / N;
    console.log(`findPath: ${perCall.toFixed(3)} ms/回（マップ全対角・${size}x${size}）`);

    // 実運用では経路は spawn 時にしか計算しない（実装書 §6）。
    // 実測 1.5ms/回（dev-vm・マップ全対角という最悪ケース）。実際のトリップはもっと短い。
    // CI マシンの速度差で落ちないよう閾値は緩く取り、致命的な退行だけを捕まえる。
    // 正確な値は上のログを見ること。
    expect(perCall).toBeLessThan(10);
  });
});
