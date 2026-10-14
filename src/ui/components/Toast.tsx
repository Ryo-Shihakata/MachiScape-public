import { useEffect } from 'react';
import { useUiStore } from '../store';

/** トースト自動消去までの表示時間。UIタイミング値なので sim/balance.ts の対象外 */
const TOAST_DURATION_MS = 3000;

/**
 * store.toast に文字列が入ったら一時表示し、TOAST_DURATION_MS 後に自動で消える。
 * 建設できない理由（資金不足など）を出すのに使う。文言は呼び出し側で t() 済みの前提。
 */
export function Toast() {
  const toast = useUiStore((s) => s.toast);
  const clearToast = useUiStore((s) => s.clearToast);

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => clearToast(), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast, clearToast]);

  if (toast === null) return null;

  return (
    <div className="hud-toast" role="status">
      {toast}
    </div>
  );
}
