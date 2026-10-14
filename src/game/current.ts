/**
 * 実行中の World への読み取り専用アクセス。
 *
 * なぜ要るか: HUD（`ui/store.ts`）は意図的に `GameState` を持たない。シミュは 10Hz で
 * 更新されるので、state を Zustand に載せると React が毎tick再描画される。
 * 一方でインスペクタ（実装書 §12.3）は「タップした建物の満足度・在庫」など
 * **任意の一点の詳細**を出す必要があり、HUD のような固定スナップショットでは表せない。
 *
 * そこで「必要なときに必要な一点だけを読む」口をここに置く。
 *
 * **規約**:
 * - **UI から state を書き換えないこと。** 変更は必ず `applyOp` を通す（実装書 §2.2）
 * - React のレンダー中に毎フレーム読まないこと。インスペクタのように
 *   一定間隔（250ms 程度）で読み直す形にする
 * - `null` を返しうる（ゲーム開始前・破棄後）。呼び出し側は必ず判定する
 */

import type { World } from '../sim/world';

let current: World | null = null;

/** `startGame` が設定する。それ以外から呼ばないこと */
export function setCurrentWorld(w: World | null): void {
  current = w;
}

/**
 * `destroy()` が自分の World を片付けるときに呼ぶ。
 *
 * **無条件に `setCurrentWorld(null)` をしてはいけない。** React 19 の StrictMode は
 * 開発ビルドで effect を2回走らせるため、`startGame` が2回呼ばれる。`startGame` は
 * `await createGameScene()` を挟んでから `setCurrentWorld` するので、
 *
 *   1. 2回目の scene が先に解決して world2 を登録
 *   2. その後で1回目の `destroy()` が走り、無条件だと world2 を消してしまう
 *
 * という順序が起こりうる。実際にこれを踏み、devサーバでインスペクタも需要内訳も
 * 何も表示されない状態になった（本番ビルドでは effect の二重実行がないので再現しない。
 * つまり**開発中だけ壊れる**という一番たちの悪い形で出る）。
 *
 * 自分が登録した World のときだけ消せば、順序に関係なく正しくなる。
 */
export function clearCurrentWorld(w: World): void {
  if (current === w) current = null;
}

/** 実行中の World。ゲーム開始前・破棄後は null */
export function getCurrentWorld(): World | null {
  return current;
}
