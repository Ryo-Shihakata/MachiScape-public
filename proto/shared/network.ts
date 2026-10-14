/**
 * P0 試作の共通契約（計画書 §7 / 実装書 §19 P0）。
 *
 * 3方式（グリッド / 自由曲線 / ヘックス）は空間モデルが異なるが、
 * 「ノードと隣接関係を持つネットワーク」という抽象では同じ形にできる。
 * ダミー交通（dummyTraffic.ts）はこの抽象だけを見て動くので、
 * 3方式で車の挙動が揃い、比較対象が「操作感と見た目」だけになる。
 *
 * 各方式がやること: ProtoNetwork の実装 + 描画 + 入力。
 * 各方式がやらないこと: 交通ロジック（共通実装を使う）。
 */

export interface NetNode {
  /** ネットワーク内で一意。方式ごとの採番でよい（グリッドならタイル、ヘックスならセル） */
  id: string;
  /** ワールド座標（タイル単位・描画と共通） */
  x: number;
  y: number;
}

export interface ProtoNetwork {
  /** 現在存在する全ノード */
  nodes(): NetNode[];
  /** id からノードを引く。存在しなければ undefined */
  node(id: string): NetNode | undefined;
  /** 隣接ノードの id 列（双方向で一貫していること） */
  neighbors(id: string): string[];
  /** ネットワークが変化したら増える。交通側がキャッシュ破棄に使う */
  version: number;
}

/** 幅優先で経路を求める。見つからなければ null */
export function findPath(net: ProtoNetwork, fromId: string, toId: string): string[] | null {
  if (fromId === toId) return [fromId];
  const prev = new Map<string, string>();
  const seen = new Set<string>([fromId]);
  const queue: string[] = [fromId];

  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const nb of net.neighbors(cur)) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      prev.set(nb, cur);
      if (nb === toId) {
        const path = [nb];
        let step = nb;
        while (prev.has(step)) {
          step = prev.get(step) as string;
          path.push(step);
        }
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}
