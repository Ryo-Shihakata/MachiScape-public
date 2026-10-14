/**
 * UI（React コンポーネント）から sim へ副作用を伴う操作を発行するための橋渡し
 * （`docs/m6-plan.md` §2 W1: エリア購入 UI）。
 *
 * `game/current.ts` は読み取り専用の口（`getCurrentWorld()` で state を読むだけ）。
 * 一方、エリア購入パネル（`ui/components/DistrictPurchase.tsx`）の「購入」ボタンは
 * `applyOp` を呼ぶ必要があるが、`applyOp` の結果を画面へ反映する処理
 * （`scene.markDirty()` で新しいチャンクの地形を描き直す等）は `game/loop.ts` の
 * `startGame` のクロージャの中にしかない。ここに登録用の関数を1つ置き、
 * `startGame` が自分の実装を差し込むことで、コンポーネント側は sim の `World` を
 * 直接持たずに「エリアを買う」という意図だけを伝えられるようにする。
 *
 * **UI から state を直接書き換えないこと。** ここを経由しても最終的に呼ぶのは
 * `sim/world.ts` の `applyOp` であり、`current.ts` の規約（変更は必ず `applyOp` を
 * 通す）を破らない。
 *
 * `current.ts` と同じ理由（React 19 StrictMode の開発時二重実行）で、解除は
 * 「自分が登録した World のときだけ」にする。
 */

import type { OpResult } from '../sim/types';
import type { World } from '../sim/world';

interface Registration {
  world: World;
  buy: (cx: number, cy: number) => OpResult;
}

let registration: Registration | null = null;

/** `startGame` が自分の実装を登録する。それ以外から呼ばないこと */
export function setBuyDistrictAction(world: World, buy: (cx: number, cy: number) => OpResult): void {
  registration = { world, buy };
}

/** `destroy()` が呼ぶ。自分が登録した World のときだけ解除する（`current.ts` と同じ規約） */
export function clearBuyDistrictAction(world: World): void {
  if (registration?.world === world) registration = null;
}

/**
 * エリアを購入する。ゲーム開始前・破棄後は何もできないので、その旨を失敗として返す
 * （呼び出し側はトーストに出すだけでよい。落ちない）。
 */
export function buyDistrict(cx: number, cy: number): OpResult {
  if (!registration) return { ok: false, reason: 'ゲームが開始されていません' };
  return registration.buy(cx, cy);
}
