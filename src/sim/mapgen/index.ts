/**
 * プロシージャルなマップ生成（実装書 §5）。
 *
 * 地形の優先順位（タイルごとに最初に該当した種になる）:
 *   1. water: 川（riverAt: 大域関数。river.ts 参照）または湖（チャンクローカルなノイズ）
 *   2. mountain: チャンクローカルな2オクターブのバリューノイズ
 *   3. forest: チャンクローカルな2オクターブのバリューノイズ
 *   4. plain: 上記以外
 *
 * 山・森・湖は「hashInts(seed, cx, cy) をそのチャンクのRNGシードにする」
 * （実装書 §5 の決定論の書き方どおり）ことで購入順に依存しない決定論を得る。
 * これはチャンク境界での見た目の連続性までは保証しない（チャンクごとに
 * 独立したノイズ場のため、境界で山・森の континuityは切れうる）。実装書が
 * 明示的にシームレスさを要求しているのは川だけなので、川は別ファイル
 * （river.ts）の大域関数 riverAt に分離してある。
 */

import { MAPGEN, SPACE } from '../balance';
import { TERRAIN_CODE } from '../grid';
import { createRng, hashInts, type Rng } from '../rng';
import type { TileKind } from '../types';
import { noiseGrid, sampleGrid } from './noise';
import { riverAt } from './river';

export { riverAt } from './river';

const CS = SPACE.CHUNK_SIZE;

// balance.ts へ移すべき値（他担当と衝突するため balance.ts は編集せず、ここに置く）
const CHUNK_NOISE_RES = 4; // チャンク内バリューノイズ（粗octave）の格子解像度
const START_CHUNK_MAX_ATTEMPTS = 300; // 開始チャンクのリトライ試行上限

interface ChunkNoise {
  heightCoarse: number[][];
  heightFine: number[][];
  forestCoarse: number[][];
  forestFine: number[][];
  lake: number[][];
}

/** rng の消費順は固定（height → forest → lake）。順序が変わると決定論が崩れる */
function buildChunkNoise(rng: Rng): ChunkNoise {
  return {
    heightCoarse: noiseGrid(rng, CHUNK_NOISE_RES),
    heightFine: noiseGrid(rng, CHUNK_NOISE_RES * 2),
    forestCoarse: noiseGrid(rng, CHUNK_NOISE_RES),
    forestFine: noiseGrid(rng, CHUNK_NOISE_RES * 2),
    lake: noiseGrid(rng, CHUNK_NOISE_RES),
  };
}

function terrainKindAt(
  seed: number,
  noise: ChunkNoise,
  gx: number,
  gy: number,
  lx: number,
  ly: number,
): TileKind {
  // 優先順位1: 川（大域）
  if (riverAt(seed, gx, gy)) return 'water';

  const u = lx / (CS - 1);
  const v = ly / (CS - 1);

  // 優先順位1: 湖（チャンクローカルノイズ）
  const lakeVal = sampleGrid(noise.lake, CHUNK_NOISE_RES, u, v);
  if (lakeVal > MAPGEN.LAKE_THRESHOLD) return 'water';

  // 優先順位2: 山（2オクターブ）
  const height =
    sampleGrid(noise.heightCoarse, CHUNK_NOISE_RES, u, v) * 0.7 +
    sampleGrid(noise.heightFine, CHUNK_NOISE_RES * 2, u, v) * 0.3;
  if (height > MAPGEN.MOUNTAIN_THRESHOLD) return 'mountain';

  // 優先順位3: 森（2オクターブ）
  const forest =
    sampleGrid(noise.forestCoarse, CHUNK_NOISE_RES, u, v) * 0.7 +
    sampleGrid(noise.forestFine, CHUNK_NOISE_RES * 2, u, v) * 0.3;
  if (forest > MAPGEN.FOREST_THRESHOLD) return 'forest';

  // 優先順位4: 平地
  return 'plain';
}

/**
 * チャンク (cx, cy) の地形を生成する。長さ CHUNK_SIZE*CHUNK_SIZE の TERRAIN_CODE 配列を返す。
 * hashInts(seed, cx, cy) をこのチャンクのRNGシードにするため、
 * どの順でチャンクを生成しても同じ地形になる（購入順に依存しない）。
 */
export function generateChunk(seed: number, cx: number, cy: number): Uint8Array {
  const rng = createRng(hashInts(seed, cx, cy));
  const noise = buildChunkNoise(rng);
  const out = new Uint8Array(CS * CS);

  for (let ly = 0; ly < CS; ly++) {
    for (let lx = 0; lx < CS; lx++) {
      const gx = cx * CS + lx;
      const gy = cy * CS + ly;
      const kind = terrainKindAt(seed, noise, gx, gy, lx, ly);
      out[ly * CS + lx] = TERRAIN_CODE[kind];
    }
  }
  return out;
}

/** チャンク(0,0)の範囲内に川タイルが1つでもあるか */
function hasRiverInStartChunk(seed: number): boolean {
  for (let y = 0; y < CS; y++) {
    for (let x = 0; x < CS; x++) {
      if (riverAt(seed, x, y)) return true;
    }
  }
  return false;
}

function plainRatio(terrain: Uint8Array): number {
  let plain = 0;
  for (const code of terrain) if (code === TERRAIN_CODE.plain) plain++;
  return plain / terrain.length;
}

/**
 * 開始チャンク(0,0)を、実装書 §5 の保証（平地率 ≥ 60%・川が1本通る）を満たすまで生成する。
 * 満たさなければ seed' = seed + attempt でリトライし、採用した seed を返す
 * （呼び出し側が GameState.seed に保存する）。試行上限に達した場合は最後の結果を返す。
 */
export function generateStartChunk(seed: number): { seed: number; terrain: Uint8Array } {
  let triedSeed = seed;
  let terrain = generateChunk(triedSeed, 0, 0);

  for (let attempt = 0; attempt < START_CHUNK_MAX_ATTEMPTS; attempt++) {
    triedSeed = seed + attempt;
    terrain = generateChunk(triedSeed, 0, 0);
    if (
      plainRatio(terrain) >= MAPGEN.START_CHUNK_MIN_PLAIN_RATIO &&
      hasRiverInStartChunk(triedSeed)
    ) {
      return { seed: triedSeed, terrain };
    }
  }

  return { seed: triedSeed, terrain };
}
