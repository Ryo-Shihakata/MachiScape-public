/**
 * エリア購入パネル（`docs/m6-plan.md` §2 W1）。
 *
 * `game/loop.ts`（`onTap` / `commitDrag`）が「解放済みに隣接する未購入チャンク」への
 * タップを拾うと `districtPurchaseTarget` が立ち、このパネルが下から出る。
 * `Inspector.tsx` / `DemandBars.tsx` と同じボトムシート形式（確認ダイアログではなく、
 * 常設のパネル + ボタン。実装書 §12.3「確認ダイアログは出さない」を守る）。
 *
 * 価格・資金・解放状況は **読むだけ**なので `getCurrentWorld()` から直接引く
 * （`game/current.ts` の規約）。購入の実行（書き込み）だけは `game/actions.ts` の
 * 橋渡しを経由する——`applyOp` の結果を `scene.markDirty()` へ反映する処理が
 * `game/loop.ts` のクロージャの中にしかないため。
 */

import { useEffect, useMemo, useState } from 'react';
import { isUnlocked } from '../../sim/progress/milestones';
import { districtPrice } from '../../sim/world';
import { buyDistrict } from '../../game/actions';
import { getCurrentWorld } from '../../game/current';
import { formatMoney, t } from '../../i18n/ja';
import { useUiStore } from '../store';
import '../district.css';

/** 価格・資金・解放状況を読み直す間隔。`src/game/current.ts` の規約（毎フレーム読まない） */
const REFRESH_MS = 250;

interface DistrictInfo {
  unlocked: boolean;
  price: number;
  affordable: boolean;
}

function readInfo(): DistrictInfo | null {
  const world = getCurrentWorld();
  if (!world) return null;
  const { state } = world;
  const price = districtPrice(state);
  return {
    unlocked: isUnlocked(state.progress.achievedMilestones, 'district'),
    price,
    affordable: state.money >= price,
  };
}

export function DistrictPurchase() {
  const target = useUiStore((s) => s.districtPurchaseTarget);
  const closeDistrictPurchase = useUiStore((s) => s.closeDistrictPurchase);
  const showToast = useUiStore((s) => s.showToast);

  // 選択中だけ読み直す（Inspector.tsx と同じ考え方。通常プレイ中の負荷はゼロ）
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!target) return;
    const id = setInterval(() => setPulse((v) => v + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [target]);

  const info = useMemo(() => (target ? readInfo() : null), [target, pulse]);

  if (!target || !info) return null;

  const handleBuy = () => {
    const result = buyDistrict(target.cx, target.cy);
    if (result.ok) {
      showToast(t('district.boughtToast'));
      closeDistrictPurchase();
    }
    // 失敗理由は game/loop.ts 側の橋渡しが既にトーストへ出しているので、ここでは
    // 二重に出さない。パネルは開いたままにして、資金を足すなどしてから再挑戦できるようにする。
  };

  return (
    <div className="dp-slot">
      <section className="dp-card">
        <header className="dp-head">
          <span className="dp-title">{t('district.title')}</span>
          <button
            type="button"
            className="dp-close"
            aria-label={t('district.close')}
            onClick={closeDistrictPurchase}
          >
            ×
          </button>
        </header>
        <div className="dp-body">
          {!info.unlocked ? (
            <p className="dp-locked">{t('district.locked')}</p>
          ) : (
            <>
              <div className="dp-row">
                <span className="dp-row-label">{t('district.price')}</span>
                <span className="dp-row-value">{formatMoney(info.price)}</span>
              </div>
              {!info.affordable && <p className="dp-warn">{t('district.insufficientFunds')}</p>}
              <button
                type="button"
                className="dp-buy"
                disabled={!info.affordable}
                onClick={handleBuy}
              >
                {t('district.buy')}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
