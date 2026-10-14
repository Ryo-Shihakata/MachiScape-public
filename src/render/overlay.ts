/**
 * 情報オーバーレイ（実装書 §12.3）。
 *
 * マップに重ねて「いま何が起きているか」を1色で見せる表示モード群。
 * **同時に有効なのは1つだけ。既定はオフ**（情報を足すほど画面はうるさくなるので、
 * 既定で静かであることを優先する）。
 *
 * 描画は `GameScene.setOverlay(draw)` に関数を渡す形で行う。`overlayLayer` は
 * 呼び出し側が毎フレーム clear してから渡すので、この中では差分描画を考えなくてよい。
 *
 * **このファイルは `src/render/` にある。** モードの列挙もここに置くのは、
 * `ui/store.ts` に置くと `render → ui` の逆流になり ESLint が弾くため
 * （依存方向は ui → render → sim）。
 *
 * ## 色の使い分け（4モード共通の約束）
 *
 * 色は `theme.ts` のトークンだけを混ぜて作る（16進の直書き禁止・ライト/ダーク両対応）。
 * 意味づけは信号機の慣習に寄せて全モードで統一する:
 *
 * | 役割 | トークン | 使う場面 |
 * |---|---|---|
 * | 悪い | `previewInvalid`（赤） | 渋滞している / 不満 / 道路が届かない |
 * | 注意 | `industrial`（琥珀） | その中間 |
 * | 良い | `residential`（緑） | 流れている / 満足 |
 * | 補助 | `preview`（青） | 「問題なし」を薄く示すだけの情報 |
 *
 * 満足度モードで緑が出ても「住宅」の意味ではない。**モードごとに色の意味が
 * 変わることは避け、赤＝手を打つべき所という一点だけを全モードで守る**。
 *
 * ## 性能
 *
 * 毎フレーム走るので、1タイルごとに `Graphics` を作らない。色と不透明度を
 * 数段に量子化し、同じ見た目のタイルを1回の `fill()` にまとめる（`TileBatch`）。
 * 結果として1モードあたりの描画命令は最大でも `RAMP_STEPS` + 数個で済む。
 */

import type { Graphics } from 'pixi.js';
import { ANALYSIS, GROWTH, ROAD, SPACE } from '../sim/balance';
import { hasRoadAccess, ZONE_CODE } from '../sim/grid';
import { congestionAt } from '../sim/road/congestion';
import { flowAt } from '../sim/road/flow';
import { chunkKey, type GameState, type TilePos, type ZoneType } from '../sim/types';
import type { OverlayDraw } from './gameScene';
import type { Theme } from './theme';

/**
 * 表示モード。'off' が既定。
 *
 * `flow`（流量）と `routes`（経路）は `docs/m5-plan.md` §4-3・§4-4 の新規モード。
 * 流量は「その道をどれだけ通ったか」＝スループット、`congestion` は「いま何台いるか」＝密度で
 * 別物なので、混ぜずに別のマップで持つ（`src/sim/road/flow.ts`）。
 */
export type OverlayMode =
  | 'off'
  | 'congestion'
  | 'satisfaction'
  | 'roadAccess'
  | 'zone'
  | 'flow'
  | 'routes';

/** 切り替えUIが並べる順。'off' は含めない（消灯は別扱いのボタンにする） */
export const OVERLAY_MODES: readonly Exclude<OverlayMode, 'off'>[] = [
  'congestion',
  'satisfaction',
  'roadAccess',
  'zone',
  'flow',
  'routes',
];

const CS = SPACE.CHUNK_SIZE;
/**
 * `grid.road` は **0=道路なし / 1=通常道路 / 2=幹線道路**（`sim/types.ts` の `RoadRank`）。
 *
 * **`=== 1` で比べてはいけない。** 以前そう書いていたため、幹線道路が
 * 混雑・流量・道路アクセスのすべてのオーバーレイから丸ごと抜け落ちていた
 * （オーナー報告「幹線道路の分析ができるようになっていない」）。
 * 幹線は「そこに交通を集めるために引く道」なので、**むしろ最も分析したい道**。
 * ランクを増やしても壊れないよう、必ずこの述語を通す。
 */
const hasRoadRank = (v: number | undefined): boolean => (v ?? 0) > 0;
const ZONE_NONE = 0;

/**
 * 見た目の調整値。**ゲームバランスではないので `balance.ts` には置かない**
 * （`gameScene.ts` の `ROAD_W` と同じ扱い）。
 */
const VIS = {
  /** タイルを少し内側に描く。隣のタイルと地続きにならず、粒として読める */
  TILE_INSET: 0.06,
  TILE_RADIUS: 0.12,
  /**
   * 混雑度の強調指数。混雑度は `min(占有数 / CAPACITY, 1)` の EMA なので、
   * 車1台なら 1/4 = 0.25 にしかならない。そのまま線形に色へ写すと
   * 実際に走っている道がほぼ緑のままで「詰まりかけ」が読めないため、
   * 1未満の指数で低い側を持ち上げる（0.25 → 約0.43 ＝ 琥珀寄り）。
   */
  CONGESTION_EMPHASIS: 0.6,
  /** 空いている道は薄く、詰まった道は濃く。赤が「光る」ようにする */
  CONGESTION_ALPHA_MIN: 0.22,
  CONGESTION_ALPHA_MAX: 0.85,
  /**
   * 満足度の濃さは「危なさ」に比例させる。順調な建物は薄く（下の建物の形が透ける）、
   * 退去寸前だけ濃く塗る。**インクの量＝手を打つ必要度**にそろえる。
   */
  SATISFACTION_ALPHA_CALM: 0.4,
  SATISFACTION_ALPHA_ALERT: 0.85,
  /** 退去済みは薄く（現状の建物描画の方針を踏襲）。もう起きてしまったことなので急かさない */
  SATISFACTION_ALPHA_VACANT: 0.3,
  /** 「アクセスあり」は数が多いので、あくまで背景として薄く */
  ACCESS_ALPHA_OK: 0.16,
  ACCESS_ALPHA_BLOCKED: 0.6,
  /** 通常の区画表示（alpha 0.28）より濃く塗って塗り分けを主役にする */
  ZONE_ALPHA: 0.85,
  /** 連続値を何段に量子化するか。段数＝描画命令数なので増やしすぎない */
  RAMP_STEPS: 6,
  /**
   * 流量（M5 §4-3）。渋滞・満足度と違い「高い＝悪い」ではなく「よく使われている」
   * というだけの情報なので、信号色のランプ（good→warn→bad）は使わず単色
   * （`info` トークン）の明るさと太さだけで表す。
   * 画面内最大値で正規化した 0..1 を、タイルの塗り面積（inset を減らす）とalphaの
   * 両方に反映させることで「明るく・太く」を同時に満たす。
   */
  FLOW_ALPHA_MIN: 0.12,
  FLOW_ALPHA_MAX: 0.92,
  FLOW_SIZE_MIN: 0.32,
  FLOW_SIZE_MAX: 0.94,
  /**
   * 経路オーバーレイ（M5 §4-4）。1台ぶんはごく薄くし、`g.blendMode = 'add'`
   * （`drawRoutes` 側で設定）と組み合わせて重なった本数だけ明るくする。
   */
  ROUTE_WIDTH: 0.1,
  ROUTE_ALPHA: 0.05,
} as const;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 連続値を RAMP_STEPS 段に丸める。同じ段のタイルは1回の fill にまとまる */
function quantize(t: number): number {
  const steps = VIS.RAMP_STEPS - 1;
  return Math.round(clamp01(t) * steps) / steps;
}

/** 0xRRGGBB を成分ごとに補間する。0xff は色ではなくビットマスク */
function mixColor(a: number, b: number, t: number): number {
  const r = Math.round(lerp((a >> 16) & 0xff, (b >> 16) & 0xff, t));
  const g = Math.round(lerp((a >> 8) & 0xff, (b >> 8) & 0xff, t));
  const bl = Math.round(lerp(a & 0xff, b & 0xff, t));
  return (r << 16) | (g << 8) | bl;
}

/** 3色ランプ。t=0 で from、0.5 で mid、1 で to */
function ramp3(from: number, mid: number, to: number, t: number): number {
  return t < 0.5 ? mixColor(from, mid, t * 2) : mixColor(mid, to, (t - 0.5) * 2);
}

/** 意味づけした色（上の表を参照）。テーマのトークンだけから作る */
function signal(theme: Theme): { bad: number; warn: number; good: number; info: number } {
  return {
    bad: theme.bad,
    warn: theme.warn,
    good: theme.good,
    info: theme.preview,
  };
}

function zoneColor(theme: Theme, z: ZoneType): number {
  return z === 'residential'
    ? theme.residential
    : z === 'commercial'
      ? theme.commercial
      : theme.industrial;
}

/**
 * 同じ色・不透明度のタイルを1回の `fill()` にまとめる蓄積器。
 *
 * Pixi v8 の `Graphics` は `rect()` を続けて呼んでから `fill()` すると、
 * 溜まったパスをまとめて1命令で塗る。1タイル1 fill にすると命令が数千になるので、
 * ここで色ごとに束ねる。**毎フレーム走るため配列は使い回す**（GC を作らない）。
 */
class TileBatch {
  private colors: number[] = [];
  private alphas: number[] = [];
  /** バケツごとの [x, y, w, h, r] の並び */
  private quads: number[][] = [];
  private used = 0;

  reset(): void {
    for (let i = 0; i < this.used; i++) this.quads[i]!.length = 0;
    this.used = 0;
  }

  add(color: number, alpha: number, x: number, y: number, size: number, radius: number): void {
    let idx = -1;
    for (let i = 0; i < this.used; i++) {
      if (this.colors[i] === color && this.alphas[i] === alpha) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      idx = this.used++;
      this.colors[idx] = color;
      this.alphas[idx] = alpha;
      if (!this.quads[idx]) this.quads[idx] = [];
    }
    this.quads[idx]!.push(x, y, size, size, radius);
  }

  flush(g: Graphics): void {
    for (let i = 0; i < this.used; i++) {
      const q = this.quads[i]!;
      if (q.length === 0) continue;
      for (let j = 0; j < q.length; j += 5) {
        const r = q[j + 4]!;
        if (r > 0) g.roundRect(q[j]!, q[j + 1]!, q[j + 2]!, q[j + 3]!, r);
        else g.rect(q[j]!, q[j + 1]!, q[j + 2]!, q[j + 3]!);
      }
      g.fill({ color: this.colors[i]!, alpha: this.alphas[i]! });
    }
  }
}

/** 同時に有効なオーバーレイは1つだけなので、蓄積器も1つを使い回す */
const batch = new TileBatch();

/**
 * 走査中のチャンク1枚ぶん。**タイルごとの `zoneAt` / `hasRoad` を避けるための入れ物**。
 *
 * これらのアクセサはタイルごとに `chunkKey`（テンプレート文字列）を作るので、
 * 9チャンク（9,216タイル）を毎フレーム舐めると文字列の生成とハッシュだけで
 * 数ミリ秒かかる（実測: 道路アクセスで 7.0 ms/フレーム）。チャンクの配列は
 * 走査の外側で1回だけ引けば十分なので、ここで持って局所インデックスで読む。
 * `redrawWorld` と違いオーバーレイは**毎フレーム**走るため、この差が効く。
 */
interface ChunkView {
  /** チャンク左上のワールドタイル座標 */
  ox: number;
  oy: number;
  road: Uint8Array | undefined;
  zone: Uint8Array | undefined;
}

/**
 * 解放済みチャンクを走査する。
 * 対象範囲は `gameScene.ts` の `redrawWorld`（`state.districts` を回す）と同じ。
 */
function forEachChunk(state: GameState, visit: (v: ChunkView) => void): void {
  const grid = state.grid;
  for (const d of state.districts) {
    const key = chunkKey(d.cx, d.cy);
    visit({
      ox: d.cx * CS,
      oy: d.cy * CS,
      road: grid.road[key],
      zone: grid.zone[key],
    });
  }
}

/**
 * `grid.ts` の `ZONE_CODE` を反転した表。
 * 独自に並びを書かず反転で作るので、`grid.ts` 側が変わっても食い違わない。
 */
const ZONE_BY_CODE: Array<ZoneType | null> = [null];
for (const [zone, code] of Object.entries(ZONE_CODE) as Array<[ZoneType, number]>) {
  ZONE_BY_CODE[code] = zone;
}

/**
 * 渋滞ヒートマップ。道路タイルを混雑度で緑→琥珀→赤に塗る。
 *
 * 道路タイル全部を塗るのは「空いている道」も見せたいから。詰まりだけ描くと、
 * 何も出ていないときに「オーバーレイが壊れている」のか「渋滞が無い」のか区別できない。
 * 余白（inset）を取らないので、繋がった道は1本の色帯として読める。
 */
const drawCongestion: OverlayDraw = (g, ctx) => {
  const { good, warn, bad } = signal(ctx.theme);
  batch.reset();
  forEachChunk(ctx.state, ({ ox, oy, road }) => {
    if (!road) return;
    for (let ly = 0; ly < CS; ly++) {
      for (let lx = 0; lx < CS; lx++) {
        if (!hasRoadRank(road[ly * CS + lx])) continue;
        const x = ox + lx;
        const y = oy + ly;
        const raw = clamp01(congestionAt(ctx.congestion, x, y));
        const t = quantize(Math.pow(raw, VIS.CONGESTION_EMPHASIS));
        batch.add(
          ramp3(good, warn, bad, t),
          lerp(VIS.CONGESTION_ALPHA_MIN, VIS.CONGESTION_ALPHA_MAX, t),
          x,
          y,
          1,
          0,
        );
      }
    }
  });
  batch.flush(g);
};

/**
 * 満足度。低い＝赤、高い＝緑（実装書 §12.3）。
 *
 * 走査は `state.buildings` を直接回す（タイル走査より安く、建物索引と二重に持たない）。
 *
 * **0..100 を素直に緑→赤へ写さないこと。** 満足度は毎日 `SATISFACTION_START`（50）へ
 * 回帰するので、50 が街の平常値になる。線形に写すと 50 がちょうど琥珀（＝注意）になり、
 * **健全な街が一面の警告色に見える**（実機で確認した）。そこで基準を退去の閾値に置き、
 *
 * - `ABANDON_THRESHOLD`（30）以下 → 赤。3日続けば人が出ていく
 * - その中間（40 あたり）→ 琥珀。落ちてきている
 * - `SATISFACTION_START`（50）以上 → 緑。平常か、それより良い
 *
 * とする。50 より上を描き分けないのは、上振れは手を打つ必要がないから
 * （発展の度合いは建物そのものの見た目で見せる担当がいる）。
 */
const drawSatisfaction: OverlayDraw = (g, ctx) => {
  const { good, warn, bad } = signal(ctx.theme);
  const span = GROWTH.SATISFACTION_START - GROWTH.ABANDON_THRESHOLD;
  const size = 1 - VIS.TILE_INSET * 2;
  batch.reset();
  for (const b of ctx.state.buildings) {
    // 0 = 平常以上、1 = 退去の閾値以下
    const alert = quantize(1 - (b.satisfaction - GROWTH.ABANDON_THRESHOLD) / span);
    const alpha = b.occupied
      ? lerp(VIS.SATISFACTION_ALPHA_CALM, VIS.SATISFACTION_ALPHA_ALERT, alert)
      : VIS.SATISFACTION_ALPHA_VACANT;
    batch.add(
      ramp3(good, warn, bad, alert),
      alpha,
      b.pos.x + VIS.TILE_INSET,
      b.pos.y + VIS.TILE_INSET,
      size,
      VIS.TILE_RADIUS,
    );
  }
  batch.flush(g);
};

/**
 * `hasRoadAccess`（`sim/grid.ts`）と同じ菱形の判定を、チャンク内の配列だけで行う。
 *
 * 判定範囲がチャンクに収まるときの近道。**同じ結果になることをテストで担保している**
 * （`overlay.test.ts` の「チャンク境界でも sim の判定と一致する」）。
 * はみ出すタイルは境界を跨ぐので、呼び出し側が `hasRoadAccess` に落とす。
 */
function accessInsideChunk(road: Uint8Array, lx: number, ly: number, distance: number): boolean {
  for (let dy = -distance; dy <= distance; dy++) {
    const rest = distance - Math.abs(dy);
    for (let dx = -rest; dx <= rest; dx++) {
      if (hasRoadRank(road[(ly + dy) * CS + (lx + dx)])) return true;
    }
  }
  return false;
}

/**
 * 道路アクセス。道路が遠すぎて建物が建たない区画タイルを赤で警告する（実装書 §8.2）。
 *
 * アクセスのある区画も薄い青で塗る。塗り分けがあることで
 * 「赤が無い＝全部届いている」と読めるようにするため（赤だけだと無警告と消灯が区別できない）。
 */
const drawRoadAccess: OverlayDraw = (g, ctx) => {
  const { bad, info } = signal(ctx.theme);
  const grid = ctx.state.grid;
  const size = 1 - VIS.TILE_INSET * 2;
  const d = ROAD.ROAD_ACCESS_DISTANCE;
  batch.reset();
  forEachChunk(ctx.state, ({ ox, oy, zone, road }) => {
    if (!zone) return;
    for (let ly = 0; ly < CS; ly++) {
      // 判定の菱形がチャンクに収まる行か（収まらない行だけ sim の関数に落とす）
      const insideY = ly >= d && ly < CS - d;
      for (let lx = 0; lx < CS; lx++) {
        if (zone[ly * CS + lx] === ZONE_NONE) continue;
        const x = ox + lx;
        const y = oy + ly;
        const ok =
          insideY && road && lx >= d && lx < CS - d
            ? accessInsideChunk(road, lx, ly, d)
            : hasRoadAccess(grid, x, y, d);
        batch.add(
          ok ? info : bad,
          ok ? VIS.ACCESS_ALPHA_OK : VIS.ACCESS_ALPHA_BLOCKED,
          x + VIS.TILE_INSET,
          y + VIS.TILE_INSET,
          size,
          VIS.TILE_RADIUS,
        );
      }
    }
  });
  batch.flush(g);
};

/** 区画の塗り分けを強調する（通常の区画レイヤは alpha 0.28 で薄い） */
const drawZone: OverlayDraw = (g, ctx) => {
  const size = 1 - VIS.TILE_INSET * 2;
  batch.reset();
  forEachChunk(ctx.state, ({ ox, oy, zone }) => {
    if (!zone) return;
    for (let ly = 0; ly < CS; ly++) {
      for (let lx = 0; lx < CS; lx++) {
        const code = zone[ly * CS + lx]!;
        if (code === ZONE_NONE) continue;
        const z = ZONE_BY_CODE[code];
        if (!z) continue;
        batch.add(
          zoneColor(ctx.theme, z),
          VIS.ZONE_ALPHA,
          ox + lx + VIS.TILE_INSET,
          oy + ly + VIS.TILE_INSET,
          size,
          VIS.TILE_RADIUS,
        );
      }
    }
  });
  batch.flush(g);
};

/**
 * 流量ヒートマップ。どの道が街の幹線になっているかを一目で見せる（M5 §4-3）。
 *
 * `flow`（`sim/road/flow.ts`）は EMA 値そのものなので上限が街の規模次第で変わる。
 * 固定のしきい値で正規化すると序盤は真っ暗、終盤は全部真っ白になるため、
 * **このフレームで画面内（解放済みチャンク）に見えている道路タイルの最大値**で割る
 * 2パス構成にする（1パス目で最大値を求め、2パス目で塗る）。
 * 混雑度と違い「高い＝悪い」ではないので、色は単色（`info`）のまま太さと明るさだけ動かす。
 */
const drawFlow: OverlayDraw = (g, ctx) => {
  const { info } = signal(ctx.theme);
  let max = 0;
  forEachChunk(ctx.state, ({ ox, oy, road }) => {
    if (!road) return;
    for (let ly = 0; ly < CS; ly++) {
      for (let lx = 0; lx < CS; lx++) {
        if (!hasRoadRank(road[ly * CS + lx])) continue;
        const v = flowAt(ctx.flow, ox + lx, oy + ly);
        if (v > max) max = v;
      }
    }
  });
  // まだ誰も走っていない（流量が全部0）なら何も塗らない。0除算を避けるためでもある。
  if (max <= 0) return;

  batch.reset();
  forEachChunk(ctx.state, ({ ox, oy, road }) => {
    if (!road) return;
    for (let ly = 0; ly < CS; ly++) {
      for (let lx = 0; lx < CS; lx++) {
        if (!hasRoadRank(road[ly * CS + lx])) continue;
        const x = ox + lx;
        const y = oy + ly;
        const t = quantize(flowAt(ctx.flow, x, y) / max);
        if (t <= 0) continue; // 一度も通っていない道は塗らない（塗った道だけが「実績」として読める）
        const size = lerp(VIS.FLOW_SIZE_MIN, VIS.FLOW_SIZE_MAX, t);
        const inset = (1 - size) / 2;
        batch.add(info, lerp(VIS.FLOW_ALPHA_MIN, VIS.FLOW_ALPHA_MAX, t), x + inset, y + inset, size, VIS.TILE_RADIUS);
      }
    }
  });
  batch.flush(g);
};

/**
 * 経路オーバーレイの計算結果のキャッシュ（M5 §4-4）。
 *
 * `state.vehicles` の全走査（最大1,500台）を毎フレームやるのは論外なので、
 * `ANALYSIS.ROUTE_REFRESH_TICKS` ごとにしか作り直さない。実際の Graphics への描画
 * （`moveTo`/`lineTo`/`stroke`）はここでは行わず、キャッシュした経路をなぞるだけの
 * `drawRoutes` に任せる（そちらは毎フレーム呼ばれるが、なぞるだけなので軽い）。
 *
 * 同時に有効なオーバーレイは1つなので、渋滞・満足度などと同じくモジュール変数1組を
 * 使い回してよい（`batch` と同じ扱い）。
 *
 * tick の差分だけで判定すると、**別の `GameState`（新しいゲーム・テストの別ケース）が
 * たまたま近い tick を持つときに前の world の経路を使い回してしまう**（実際にテストで
 * 再現した）。`state` の参照が変わったら tick 差に関係なく作り直す。
 */
let routeCacheState: GameState | null = null;
let routeCacheTick = -1;
let routePaths: ReadonlyArray<readonly TilePos[]> = [];

function refreshRouteCache(state: GameState): void {
  if (
    state === routeCacheState &&
    routeCacheTick >= 0 &&
    state.tick - routeCacheTick < ANALYSIS.ROUTE_REFRESH_TICKS
  ) {
    return;
  }
  routeCacheState = state;
  routeCacheTick = state.tick;
  // 上限（`ROUTE_MAX_VEHICLES`）を超えたぶんは id 昇順で切り捨てる。
  // 決定論的な間引きにしないと、同じ状態を再現しても表示が毎回違う絵になる。
  const running = state.vehicles
    .filter((v) => v.phase !== 'dwell' && v.path.length > 1)
    .sort((a, b) => a.id - b.id)
    .slice(0, ANALYSIS.ROUTE_MAX_VEHICLES);
  routePaths = running.map((v) => v.path);
}

/**
 * いま走っている全車の経路を半透明で重ね描きする（M5 §4-4）。
 *
 * 流量（`drawFlow`）が「道の実績」なのに対し、こちらは「いまの人の流れ」を見せる。
 * `g.blendMode = 'add'` で加算合成にすることで、同じ道を通る車が多いほど
 * 1台ぶんの薄いストロークが重なって自然に濃くなる。
 */
const drawRoutes: OverlayDraw = (g, ctx) => {
  refreshRouteCache(ctx.state);
  if (routePaths.length === 0) return;
  const { info } = signal(ctx.theme);
  g.blendMode = 'add';
  for (const path of routePaths) {
    const first = path[0];
    if (!first) continue;
    g.moveTo(first.x + 0.5, first.y + 0.5);
    for (let i = 1; i < path.length; i++) {
      const point = path[i];
      if (!point) break;
      g.lineTo(point.x + 0.5, point.y + 0.5);
    }
    g.stroke({ width: VIS.ROUTE_WIDTH, color: info, alpha: VIS.ROUTE_ALPHA, cap: 'round', join: 'round' });
  }
};

/** モードに対応する描画関数を返す。'off' は null（＝何も描かない） */
export function overlayDrawFor(mode: OverlayMode): OverlayDraw | null {
  switch (mode) {
    case 'congestion':
      return drawCongestion;
    case 'satisfaction':
      return drawSatisfaction;
    case 'roadAccess':
      return drawRoadAccess;
    case 'zone':
      return drawZone;
    case 'flow':
      return drawFlow;
    case 'routes':
      return drawRoutes;
    case 'off':
      return null;
  }
}
