# MachiScape M4 実装計画

> **【2026-07-31 改訂】この文書の主題は「施設と進行」から「交通が見える・反応する」に変わった。**
> 施設と進行は M5 へ後ろ倒し。経緯と新しいマイルストーン分割は §0 を参照。
> **M5 に着手する人は、下の §3〜§5（施設・マイルストーン・エリア拡張）をそのまま読めばよい**
> （中身は有効。番号だけ繰り下がる）。

---

## 0. 改訂の経緯とマイルストーンの再分割（2026-07-31）

M3 完了後、オーナーから5つの要望が出た:

1. 交差点の見た目が不自然。完全な十字型にしたい（または信号）
2. ルート選定をもっとリアルに。混雑していたら他の道を使ってほしい
3. 車がどの建物から出入りしたか分かりづらい
4. もっと「まちづくり」に焦点を当てたい
5. （4の内訳として）置けるものが少ない / 目標や段階がない / 住民の暮らしが見えない / 道路以外の手段がない

**別系統モデル（GPT-5, reasoning effort=high）に設計の意見を求め、その推奨をオーナーが採用した。**

### 決まったこと

| 論点 | 決定 | 根拠 |
|---|---|---|
| 交差点 | **まず描画だけ直す。信号は入れない** | 信号は「交差点が変に見える」問題の解ではない。v1での手動信号はやめるべきとGPT-5が明言 |
| 動的迂回の強さ | **弱め（一部の車が遅れて移る）** | **最大の懸念**: 迂回が賢すぎると、ゲームがプレイヤーの代わりに渋滞を解いてしまい、「道路網を考えるパズル」という核が消える |
| 鉄道・バス | **v2のまま**（v1に入れない） | まず道路だけで面白くする。受け口の型（`Mode`）はv1に用意済み |
| 施設 | **公園・学校・病院の3種だけの垂直スライス**（5種一括はやめる） | 「置く場所を考える楽しさ」が本当に生まれるかを先に判定する。5種作ってから判定すると手戻りが大きい |

### 新しいマイルストーン分割

**要望1〜4を1つのマイルストーンに詰め込まない。**

| ID | 主題 | 入れる | 明確に入れない |
|---|---|---|---|
| **M4** | **交通が見える・反応する** | 交差点の描画修正 / 建物の出入りの可視化 / **弱い**動的迂回 | 信号・施設・エリア拡張 |
| M5 | まちづくりの垂直スライス | 施設3種（公園・学校・病院）+ マイルストーン進行 | 市役所・スタジアム・エリア拡張 |
| M6 | 街を広げる | エリア拡張UI / 残りの施設（M5の判定次第） | 新規のシム機構 |
| M7 | 仕上げ | セーブ・タイトル・チュートリアル・効果音・設定 | — |
| M8 | バランスと公開 | 実機での調整・性能の最終確認・デプロイ | — |

### M4 の進捗（2026-07-31）

- ✅ **交差点の描画修正**（完了・コミット済み）。詳細は下記
- ⏳ 建物の出入りの可視化
- ⏳ 弱い動的迂回

#### 交差点の修正で分かったこと（記録）

十字路の**4本の腕のタイルは互いに斜め隣接している**。8方向をそのまま繋ぐと斜めのショートカットが
4本描かれ、交差点が「十字」ではなく**菱形**になる。

**これは描画だけの問題ではなかった。** 経路探索も同じ8方向なので、車は実際にその斜め
（√2 ≒ 1.41 < 2）を通っていた。描画だけ直すと**車が道路の無い角を横切って見える**。

そこで規則を1か所（`src/sim/road/connectivity.ts`）に集約し、**描画と経路探索が同じ規則を使う**ようにした:

> 斜めが成立するのは「共有する2つの直交隣接タイルのどちらも道路でない」ときだけ

階段状の斜め道路（D3の目的）は保たれ、十字路では交差点を経由する。連結性は失われない
（斜めを落とすのは直交2手の代替が必ず存在するときだけ）。

#### 仕様書の誤りを2件訂正した

実装書 §6 が**実装されていない挙動**を書いていた（`docs/implementation-spec.md` に訂正済み）:

- 「同一辺に `TICKS_STUCK` tick 滞留したら再探索」→ **`isStuck()` は定義されているだけで呼び出しが無い**
- 「道路撤去時に残経路を再探索」→ **実際は車を消しているだけ**

つまり**走行中の動的な迂回は一度も実装されていなかった**。要望2は「既存機構の改善」ではなく
**「再探索スケジューラの新設」**として見積もる必要がある。

---

## 1'. 旧計画（M5 以降で使う）— 「施設と進行」

> **この文書は前提知識ゼロで読めるように書いてある。** 初めてこのプロジェクトに触る人・
> エージェントは、この文書と `docs/implementation-spec.md`（全仕様のSSOT）だけで作業できる。
>
> 作成: 2026-07-30 / 位置づけ: `docs/roadmap-m4-onward.md` の M4 節を**ファイル単位まで詳細化**したもの。
> M5・M6 はロードマップのままにしてある（M3 の結果で中身が変わるため、先に詳細化しても作り直しになる）

---

## 0. 3行で

- M4 の目的は **プレイヤーに「置く場所を考える楽しさ」と「次の目標」を与える**こと。
- 中身はユニーク施設5種・マイルストーン進行・エリア拡張UI。**仕様は実装書 §10・§11 で確定済み**。
- 最大の作業は施設そのものではなく、**交通の目的地を「建物」から「建物または施設」へ一般化する**こと。

**着手条件**: M3（`docs/m3-plan.md`）が完了していること。特に **M3 の W4（往復トリップ）が入った後**に
着手する（施設が目的地になると往復の対象にもなるため、順序を逆にすると往復の実装をやり直す）。

---

## 1. プロジェクト概要（初見の人向け）

**MachiScape** は Mini Metro / Mini Motorways の系譜にあるミニマルなまちづくりWebゲーム。
道路を引き、区画（住宅・商業・工業）を塗ると建物が自動で建ち、住民の車と物流トラックが実際に道路を走る。
渋滞は車の密度から自然に発生する。ゲームオーバーは無い。スマホ優先・無料公開予定。

| 層 | 技術 | 場所 |
|---|---|---|
| シミュレーション | 純TypeScript（依存ゼロ・**決定論**） | `src/sim/` |
| 描画 | Pixi.js v8（WebGL） | `src/render/` |
| UI | React 19 + Zustand（**UI状態のみ**） | `src/ui/` |
| ゲームループ・入力 | 純TS | `src/game/` |

**絶対に守るルール**（実装書 §0）:

1. `src/sim/` では `Math.random` / `Date` / DOM / Pixi / React を**使用禁止**（ESLintが機械的に弾く）。乱数は `src/sim/rng.ts` のシード付きRNGのみ
2. **数値の直書き禁止。** バランス数値はすべて `src/sim/balance.ts` に集約する
3. ユーザー向け文字列は `src/i18n/ja.ts` の `t()` 経由
4. 依存方向は `ui → render → sim`。逆流禁止（ESLintで強制）
5. **同じ入力なら必ず同じ結果**（決定論）。走査順・タイブレークを固定する

```bash
pnpm install
pnpm dev        # 開発サーバ（--host 付き）
pnpm test       # Vitest
pnpm typecheck  # tsc --noEmit
pnpm lint       # eslint
pnpm build      # 本番ビルド
```

**注意**: TypeScript は 6.0.3 に固定してある。TS 7 は typescript-eslint が未対応で lint が起動しない。

---

## 2. 現状（コードを読んで確認した事実）

### 既に用意されているフック — **新しく作る必要はない**

M1〜M2 の実装時に「M3（＝再編後の M4）で使う」と分かっていたものが仕込まれている。
**まずこれらを探すこと。**知らずに別の場所に実装すると二重になる。

| ある物 | 場所 | 使い方 |
|---|---|---|
| `Facility` 型 / `facilities: Facility[]` | `src/sim/types.ts` | そのまま使える |
| `grid.facilityIndex` | `src/sim/types.ts`, `src/sim/grid.ts` | `facilityIdAt(grid, x, y)` が既にある。footprint の全占有タイルを登録する |
| `placeFacility` / `removeFacility` の `BuildOp` | `src/sim/types.ts` | 型は完成。中身が無いだけ |
| `ECONOMY.FACILITY_REFUND_RATIO = 0.25` | `src/sim/balance.ts` | 撤去返金 |
| `facilityUpkeep(state)` の空実装 | `src/sim/economy/index.ts:42` | ここに合算処理を書く。コメントで場所が指定されている |
| `MOVE_IN.BASE_WEIGHT = 1` | `src/sim/balance.ts` | `processMoveIn` の `weightedPick` は**既にこれを掛けている**。`growthMul` を掛ける口として用意された |
| `GROWTH.ABANDON_DAYS_WITH_HOSPITAL = 4` | `src/sim/balance.ts` | 病院バフ。まだ未使用 |
| `TRAFFIC.DEST_WEIGHT_FACILITY = 0.15` | `src/sim/balance.ts` | 施設を行き先にする重み。まだ未使用 |
| `DayReport.rewards` | `src/sim/types.ts` | `settleDay` が常に `0` を入れている（`economy/index.ts:94`） |
| `progress.achievedMilestones: string[]` | `src/sim/types.ts` | 空配列のまま |
| `theme.facility = 0xc76f6f` | `src/render/theme.ts` | 施設の描画色 |
| `t('tool.facility') = '施設'` | `src/i18n/ja.ts` | ツールバーのラベル |
| `buyDistrict` の sim 実装 + `districtPrice()` | `src/sim/world.ts:209`, `:324` | **動く。テスト済み。UIが無いだけ** |

### 無い物 = M4 で作る物

- `src/sim/facility/`（ディレクトリごと無い）
- `src/sim/progress/`（同）
- `applyOp` / `canApplyOp` の `placeFacility` / `removeFacility` は
  `fail('施設はまだ実装されていない（M3）')` を返す（`src/sim/world.ts:215`, `:289`）
  — **このエラーメッセージの「M3」は再編前の番号。実装時に消えるので直さなくてよい**
- 施設をツールバーから置くUI・マイルストーンのUI・エリア購入のUI

---

## 3. W1: ユニーク施設

**担当ファイル**
- 新規: `src/sim/facility/defs.ts`, `src/sim/facility/index.ts`, `src/sim/facility/index.test.ts`
- 変更: `src/sim/world.ts`（`applyOp` / `canApplyOp` の施設分岐）, `src/sim/balance.ts`,
  `src/sim/traffic/trips.ts`（目的地の一般化）, `src/sim/growth/index.ts`（バフ適用）,
  `src/sim/economy/index.ts`（維持費・税収バフ）, `src/render/gameScene.ts`（施設の描画）,
  `src/ui/components/Toolbar.tsx`, `src/i18n/ja.ts`

### 3-1. 定義（データ駆動にする）

`src/sim/facility/defs.ts` に実装書 §10 の型と配列をそのまま置く。

```ts
export interface FacilityDef {
  id: string;
  cost: number; upkeep: number;
  attraction: number;          // 0なら行き先にならない
  buff?: { radius: number; satisfactionFloor?: number; growthMul?: number; taxMul?: number };
  unlock: { milestoneId: string } | 'start';
  footprint: 1 | 4;            // 1x1 or 2x2。pos は左上タイル
}
```

初期セット5種（実装書 §10 の表がそのまま仕様）:

| id | 名称 | cost/upkeep | attraction | バフ | 解放 | 占有 |
|----|------|------|------|------|------|------|
| park | 公園 | 200 / 1 | 2 | r5: 満足度下限 +10 | 開始時 | 1x1 |
| school | 学校 | 500 / 3 | 6 | r8: 入居抽選の重み ×1.2 | pop100 | 1x1 |
| hospital | 病院 | 800 / 5 | 4 | r10: 退去条件を4日連続に延長 | pop300 | 1x1 |
| cityhall | 市役所 | 1200 / 8 | 5 | 全域: 税収 ×1.05 | pop500 | 2x2 |
| stadium | スタジアム | 0（報酬・無料設置） / 10 | 20 | — | pop1000 | 2x2 |

- **数値はすべて `balance.ts` に置き、`defs.ts` は balance を参照する**。`defs.ts` に数字を直書きしない
- 市役所の「全域」は `radius: Infinity` ではなく `buff` を持たない別枠（`global: { taxMul: 1.05 }`）にするか、
  半径を十分大きな定数にするか、実装者が決めてよい。**ただし `Infinity` は避ける**
  （セーブのJSON化で `null` に化ける。実装書 §13）
- **受け入れ基準の一つが「施設を1つ増やすのに配列へ1行足すだけで済むこと」。**
  `switch (defId)` を書いたらこの基準を満たさない

### 3-2. 配置と撤去（`applyOp`）

`src/sim/world.ts` の `placeFacility` / `removeFacility` を実装する。

**検証（`canApplyOp` に書く。UI のプレビューが同じ関数を通ること）**

1. その `defId` が解放済みか（`progress.achievedMilestones` と `def.unlock` を照合）
2. footprint の全タイルが解放済みチャンク内で、地形が `plain` または `forest`（`mountain` / `water` は不可）
3. footprint の全タイルに道路・建物・他の施設が無い（`hasRoad` / `buildingIdAt` / `facilityIdAt`）
4. **道路アクセス**: footprint の**いずれか1タイル**が `hasRoadAccess(grid, x, y, ROAD.ROAD_ACCESS_DISTANCE)`
5. 費用（`def.cost` + 森タイルぶんの `COST_CLEAR_FOREST`）が残高以下

**適用**

- `state.facilities.push({ id: state.nextId++, defId, pos })`
- **footprint の全占有タイルを `grid.facilityIndex` に登録する**（1x1 なら1つ、2x2 なら4つ）。
  ここを1タイルだけにすると重複判定が抜けて施設が重なる
- 森は `clearForest` と同じ扱いで `plain` に戻す（既存のプライベート関数を再利用できる形に整える）
- **区画（zone）が塗られていたら消す。** M3 の W1 で「道路を引いたら区画を消す」と決めたのと同じ理由
  （同じタイルに施設と区画が同居する状態は意味を持たない）
- **建物があるタイルには置けない（上の検証3で弾く）。** 道路の場合は M3 で「建物ごと消す」としたが、
  施設は違う扱いにする。理由: 道路は線を引く操作なので通り道の建物を巻き込むのが自然だが、
  施設は1点を狙って置く操作であり、**狙った場所の家が黙って消えるのは事故にしか見えない**。
  UI は置けない理由をトーストで出す

**撤去（`removeFacility`）**

- `state.facilities` から削除し、`grid.facilityIndex` から**全占有タイルを削除する**
- 返金 `Math.floor(def.cost * ECONOMY.FACILITY_REFUND_RATIO)`
- **その施設を目的地にしている車を消す**（`purpose.to` が footprint 内の車）。
  失敗トリップには数えない（`demolishRoad` と同じ扱い。既存の `removeVehiclesOnTiles` に倣う）

### 3-3. 施設を人流の目的地にする（**このW1で最も重いところ**）

現状 `pickDestination`（`src/sim/traffic/trips.ts:42`）は **`Building` しか返さない**。
`TRAFFIC.DEST_WEIGHT_FACILITY = 0.15` は定義済みだが使われていない。

一般化する。**型を増やすのが最小の手**:

```ts
export type TripTarget =
  | { kind: 'building'; id: number; pos: TilePos }
  | { kind: 'facility'; id: number; pos: TilePos; footprint: 1 | 4 };
```

- `pickDestination` の戻り値を `TripTarget | null` にする
- 重みは実装書 §7.1 のとおり **種別の重み × `attraction / (1 + dist / DISTANCE_FALLOFF)`**
  - 建物は `attraction` を持たないので **1 として扱う**（現在の実装と同じ挙動になる）
  - 施設は `DEST_WEIGHT_FACILITY × def.attraction / (1 + dist / DISTANCE_FALLOFF)`
  - `attraction === 0` の施設は候補に入れない
- **決定論**: 候補の列挙順を固定する。建物は `state.buildings` の順（＝id昇順）、
  施設は `state.facilities` の順で、**建物 → 施設の順に並べる**。順序が揺れると `weightedPick` の結果が変わる

**`accessRoadOf` も一般化が要る。** 現在のシグネチャは `(state, b: Building)` で、建物の座標から
最寄りの道路タイルを探している（`trips.ts:20`）。

- `accessRoadNear(state, pos: TilePos, footprint: 1 | 4): TilePos | null` に置き換える
- 2x2 は4タイルそれぞれの周囲を見て、**最も近い道路タイル**を返す。同距離のタイブレークは
  既存と同じ走査順（`dy` 昇順 → `dx` 昇順）で固定する
- `accessRoadOf(state, building)` は新関数の薄いラッパとして残してよい（呼び出し箇所が減って安全）

**M3 の往復トリップとの接続**（M3 W4 が先に入っている前提）

- 施設への往路 → 滞在 → 復路（自宅へ帰る）が成立すること
- **満足度の加算は往路の到着時に1回だけ**（M3 で決めた規則をそのまま守る）
- `deliverCargo`（`trips.ts:221`）は `purpose.to` の座標で商業建物を探す。
  施設の座標と商業建物の座標が一致することは無い（同じタイルに置けないため）ので**変更不要**。
  ただし `find` が空振りする経路が増えるので、`v.kind !== 'truck'` の早期returnが効いていることを確認する

### 3-4. バフを効かせる（適用箇所を間違えないこと）

バフは4種類あり、**効かせる場所がそれぞれ違う**。ここを外すと「置いても何も起きない施設」になる。

| バフ | 効かせる場所 | 具体的に |
|---|---|---|
| `satisfactionFloor`（公園） | `src/sim/growth/index.ts` の `updateSatisfaction` | クランプの下限を `GROWTH.SATISFACTION_MIN` から `MIN + floor` に上げる。**退去判定より前に適用する**（そうしないと公園が退去を防げない） |
| `growthMul`（学校） | `src/sim/growth/index.ts` の `processMoveIn` | `weightedPick(rng, from.map(() => MOVE_IN.BASE_WEIGHT))` の `BASE_WEIGHT` に乗算する。**既にこの形になっているので1行の変更で済む** |
| 退去猶予（病院） | `src/sim/growth/index.ts` の `updateSatisfaction` | 退去判定の閾値を `GROWTH.ABANDON_DAYS` → `ABANDON_DAYS_WITH_HOSPITAL` に差し替える |
| `taxMul`（市役所） | `src/sim/economy/index.ts` の `computeTaxIncome` | 合算後に乗算する（建物ごとに掛けても同じだが、全域バフなので最後に1回でよい） |

**重複の規則（実装書 §10）: 同種は非累積・異種は累積。**
実装は `src/sim/facility/index.ts` にヘルパを置くのが素直:

```ts
export interface ResolvedBuffs {
  satisfactionFloor: number;   // 同種非累積 = 最大値を採る
  growthMul: number;           // 異種累積 = 乗算
  abandonDays: number;
}
export function buffsAt(state: GameState, pos: TilePos): ResolvedBuffs
```

- 「同種非累積」は **公園を2つ重ねても +10 のまま**（最大値を採る）という意味
- **走査順は `state.facilities` の順（id昇順）に固定する**
- **性能**: `buffsAt` は建物ごとに呼ばれるので O(建物 × 施設)。日次処理なので
  建物2,000 × 施設20 = 40,000回/日（＝600tickあたり）。予算内なので**先に最適化しないこと**。
  ただし `processMoveIn` は**空き区画タイルごと**に呼ぶ形になりやすく、
  こちらはタイル数が数千になりうる。空きタイルの列挙は1日1回なので問題ないが、
  ベンチ（`src/sim/world.bench.test.ts`）の数値は施設を置いた状態でも測ること

### 3-5. 描画とUI

- **描画**（`src/render/gameScene.ts`）: `theme.facility` の角丸矩形。2x2 は2×2タイルを埋める1つの図形として描く。
  建物と見分けがつく形にする（例: 建物より角丸を大きく、または縁を付ける）。
  **`redrawWorld` の dirty 再描画に乗せる**（施設は毎フレーム変わらない）
- **ツールバー**（`src/ui/components/Toolbar.tsx`）: `tool: 'facility'` を追加し、
  **解放済みの施設だけ**を並べる。未解放はロック表示（M4 W2 と繋がる）
- **配置プレビュー**: footprint のサイズで可否を色分けする。`canApplyOp` を通すこと（二重実装しない）
- **文字列**: 施設名・説明は `src/i18n/ja.ts` に `facility.park.name` / `facility.park.desc` の形で追加する

### 3-6. 受け入れ基準

- 5種すべてが置ける・撤去できる（撤去は建設費の25%返金）
- **施設が人流の目的地になっている**（車が施設へ向かい、往復して帰る）
- バフが実際に効いている。**テストで担保する**:
  - 公園の範囲内の建物が満足度の下限を割らない
  - 学校の範囲内のタイルが範囲外より高い確率で選ばれる（同一シードで比較）
  - 病院の範囲内では3日連続の低満足度で退去せず、4日で退去する
  - 市役所があると `DayReport` の税収が5%増える
  - **同種を2つ重ねても効果が increase しない**（非累積の確認）
- 施設を1つ追加するのに `defs.ts` の配列へ1行足すだけで済む
- `grid.facilityIndex` に footprint の全タイルが登録され、重なって置けない
- 決定論テストが緑（施設を置く操作を含む操作列でハッシュ一致）

---

## 4. W2: マイルストーン進行

**担当ファイル**
- 新規: `src/sim/progress/defs.ts`, `src/sim/progress/index.ts`, `src/sim/progress/index.test.ts`
- 変更: `src/sim/world.ts`（`stepDay` に判定を挿入）, `src/sim/pipeline.ts`（処理順の契約）,
  `src/sim/economy/index.ts`（`rewards`）, `src/ui/store.ts`, `src/ui/components/TopBar.tsx`,
  `src/ui/components/Toolbar.tsx`, `src/i18n/ja.ts`

### 4-1. 定義

```ts
export interface MilestoneDef { id: string; pop: number; rewardMoney: number; unlocks: string[] }
```

| pop | 報奨金 | 解放 |
|-----|------|------|
| 100 | 500 | 学校 |
| 300 | 800 | 病院 |
| 500 | 1200 | 市役所・**エリア購入** |
| 1000 | 2000 | スタジアム・**3x速度** |
| 2000 | 3000 | （バッジのみ） |
| 5000〜 | 2000ごと繰り返し | （バッジのみ・エンドレス） |

- エンドレス部分は**配列を無限に書くのではなく、`nextEndlessMilestone(pop)` のような関数で生成する**。
  ただし `achievedMilestones` に入れる id は決定的な文字列にする（例: `endless-6000`）

### 4-2. 判定と報奨金 — **処理順が重要**

達成判定は**日次**（毎tickやらない）。`src/sim/world.ts` の `stepDay` に挿入する。

現在の `stepDay` の順序:

```
computeBuildingStats → computeDemand → processMoveIn → processLogistics
  → spawnFreightTrips → updateSatisfaction → settleDay
```

**`checkMilestones` は `settleDay` の直前に入れる。**

- 理由: 報奨金は `DayReport.rewards` に計上する仕様（実装書 §11・現在は `economy/index.ts:94` で
  常に `0`）。`settleDay` より後に判定すると、報奨金がその日のレポートに載らず、
  資金の増減とHUDの内訳表示が食い違う
- 人口は `settleDay` の中で `countPopulation` として数え直されている。
  判定に使う人口は **`processMoveIn` 後の実際の値**であるべきなので、
  `checkMilestones` は自分で数えるか、`stats` を使い回さずに再集計する
  （`stats.population` は `processMoveIn` の**前**の値なので使ってはいけない）
- `rewards` の受け渡しは `settleDay` の引数を増やすのが素直。
  **`pipeline.ts` の `SettleDay` 型と、順序を説明したコメントを必ず更新する**
  （`pipeline.ts` は「順序を実装側で決めないこと」を明文化しているファイル）

**冪等性**: `progress.achievedMilestones.includes(def.id)` で二重達成を防ぐ。
**同じマイルストーンで報奨金が二度出ないことをテストで担保する**（受け入れ基準）。

### 4-3. UIへの反映

- **バナー**: 達成時に表示。**効果音は M5 だが、鳴らす場所（呼び出し点）は M4 で用意しておく**
  （空の関数を1つ置いて、M5 でその中身を書く）
- **3x速度のロック**: `pop1000` 未達の間は速度ボタンをロック表示（実装書 §12.2）。
  `src/ui/store.ts` の `Speed` は `0 | 1 | 2 | 3` のままでよく、
  **`HudSnapshot` に解放状態を持たせる**のが素直（`loop.ts` の `pushHud` が
  `progress.achievedMilestones` から導出して詰める）。`setSpeed(3)` を未解放時に弾くこと
- **施設のロック**: ツールバーで未解放の施設をロック表示（W1 と繋がる）
- **マイルストーン進捗バー**: 下部ツールバーの上に細く（実装書 §12.2）。次の目標と現在人口を出す

### 4-4. 受け入れ基準

- 人口到達で施設が解放され、報奨金が入り、`DayReport.rewards` に載る
- 未解放の施設・速度がUIでロックと分かり、実際に使えない
- **同じマイルストーンで二重に報奨金が出ない**（テスト）
- エンドレス（pop5000以降2000ごと）が繰り返し達成される（テスト）
- 決定論テストが緑

---

## 5. W3: エリア拡張

**担当ファイル**
- 変更: `src/sim/world.ts`（購入可能判定の公開・マイルストーンによる開放）,
  `src/render/gameScene.ts`（購入候補の表示）, `src/ui/components/`（購入UI）,
  `src/i18n/ja.ts`

**sim 側は既に動く。** `applyOp` の `buyDistrict` と `districtPrice()` は実装済み・テスト済み
（`src/sim/world.ts:209`, `:324`）。**残作業はUIと、購入の解放ゲート。**

### 5-1. やること

- **`canApplyOp` に解放ゲートを足す。** 現在の `buyDistrict` の検証は
  「未解放チャンク」「隣接」「資金」の3つだけで、**pop500 のマイルストーンを見ていない**。
  ここを足さないと初日からエリアが買える
- **購入候補を UI に公開する。** `isAdjacentToOwned` は `world.ts` のプライベート関数。
  `purchasableDistricts(state): Array<{cx, cy, price, reason?}>` を `world.ts` から export する
  （UI が同じ判定を書き直さないため）
- **描画**: 解放済みエリアの外側に点線の枠と価格を出す。`gameScene.ts` の `redrawWorld` に足す
  （`state.districts` を走査してチャンク境界を描いている箇所の隣）
- **購入操作**: 枠をタップ → 確認 → 購入。買えない理由（未解放・資金不足・非隣接）を
  トーストで区別して出す
- 買った直後に地形が見えること（`addChunk` + `generateChunk` は `applyOp` が既に呼んでいる。
  `scene.markDirty()` を忘れないこと）

### 5-2. 性能上の注意（エリアが増えると効いてくる）

チャンクを買うほど**チャンク単位の全走査が重くなる**箇所が2つある。M4 で顕在化する。

| 場所 | 何をしているか | 頻度 |
|---|---|---|
| `listRoadTiles`（`src/sim/world.ts:87`） | 解放済み全チャンクの 32×32 を走査して道路タイルを集める | **`advance()` 1回につき1回**＝実質毎フレーム |
| `countRoadTiles`（`src/sim/economy/index.ts:23`） | 同じ走査を維持費の計算で | 1日1回 |

チャンク1つで1,024タイル。10チャンク買えば毎フレーム10,240回の判定になる。

- **M4 で先回りの最適化はしない**（実装書 §17「早すぎる最適化をしない」）
- ただし **`pnpm test` のベンチで、チャンクを10個購入した状態の `advance` を測ること**。
  5ms/tick の予算に近づいていたら、`grid` に道路タイル数と道路タイル一覧を
  インクリメンタルに持たせる（`setRoad` で更新する）のが最初の一手。**引き継ぎに数値を残す**

### 5-3. 受け入れ基準

- pop500 未達では買えず、UIでもそれが分かる
- 購入UIから隣接チャンクを買える。買えない理由が区別して表示される
- 買った直後に地形が見える
- 価格が `1000 × 1.5^(有償購入済み数)` で増える（既存テストが担保。**壊さないこと**）
- チャンク10個購入状態で `advance` が 5ms/tick 以内（実測値を報告する）

---

## 6. 順序と並列

```
W1 施設 ──┬──→ W2 マイルストーン（施設の解放条件になるので W1 の後）
          │
          └──→（W3 の描画部分は W1 と同じ gameScene.ts を触るので直列）
                    ↓
              W3 エリア拡張UI（pop500 で解放されるので W2 の後）
```

**M4 は基本的に直列。** W1 → W2 → W3 が解放条件と担当ファイルの両方で繋がっているため、
M3 のような並列化の余地は小さい。

**唯一並列にできるのは M5 の W1（セーブ/ロード）**。担当ファイルが `src/save/`（新規）で
重ならない。ただし**セーブは M4 のデータ形式が固まってから着手する**（`GameState` に
`facilities` の中身とマイルストーンの記録が増えるため、先に作ると移行が必要になる）。
M4 W1 の型が確定した時点で並列に走らせるのが最も効率がよい。

### 委譲の方針

- **W1（施設）は Opus に委譲する。** 目的地の一般化とバフの適用箇所の判断が入る
- **W2・W3 は Sonnet でよい。** 仕様が確定していて機械的
- 長時間作業は**途中でもコミットさせる**（セッション上限で中断されても成果が残る）

---

## 7. 検証方法

各パッケージ完了時:

1. `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` を**終了コードで**確認
   （`echo $?`。`pnpm test 2>&1 | tail` はパイプで終了コードが隠れる）
2. `pnpm dev` を起動し、ヘッドレスブラウザ（Playwright）で操作してスクリーンショットを撮る
   - WebGL の canvas を `drawImage` で読むと**真っ黒になる**。判定は `page.screenshot()` の PNG をデコードして行う
   - ヘッドレスの WebGL は `--use-gl=swiftshader --enable-unsafe-swiftshader --no-sandbox` が必要
   - **ヘッドレスのFPSは13〜21しか出ない。性能評価には使えない**（描画されているかの確認のみ）
3. 性能は `src/sim/*.bench.test.ts` の実測値をログで確認

M4 全体の完了条件:

1. W1〜W3 の受け入れ基準を満たす
2. 全ゲート緑
3. **人口1000まで通しでプレイできる**（ヘッドレスでの長時間実行または手動確認）
4. 性能: 車両1500台で 1tick ≤ 5ms を維持
5. **実機（スマホ）でのFPSをここで一度測る。** M6 まで待たない
   （`docs/roadmap-m4-onward.md` §6 のリスク「公開直前に性能不足が発覚」への対策）
6. 会話を知らない verifier に検証を委譲する
7. **オーナーに一度触ってもらう**: 「施設を置く場所を考えるのは楽しいか」

---

## 8. リスクと撤退条件

| 死因 | 早期警報 | 回避策 |
|---|---|---|
| **目的地の一般化で交通が壊れる** | 決定論テストが落ちる／車が施設に行かない／人口が伸びない | 候補の列挙順を「建物→施設」で固定する。**建物だけの状態で既存テストが全部緑のままであることを先に確認**してから施設を候補に足す |
| **バフが効いているか分からず、施設を置く動機が生まれない** | オーナーが「置く意味が分からない」と言う | **M3 のインスペクタに「この建物は公園のバフを受けている」を表示する**。M3 の W3b と設計を繋げること。表示が無いバフは存在しないのと同じ |
| **バフが強すぎ/弱すぎで最適解が1つになる** | 「公園を敷き詰めるだけ」になる | 数値は `balance.ts` にあるので M6 で調整する。**M4 では調整しない**（判定はオーナー） |
| **セーブ形式を後から変えて移行が要る** | M5 でセーブを作る時点で `GameState` の形がまだ動いている | セーブは M4 W1 の型が確定してから着手する。移行機構（`migrations`）は最初から入れる |

**撤退条件**: **スタジアム（pop1000・2x2・attraction 20）は落としてもよい。**
pop1000 に到達するプレイ時間が長く、M4 の目的（置く場所を考える楽しさ）は
公園・学校・病院の3種で判定できる。市役所も同様に後回し可。
**逆に落とせないのは「施設が目的地になること」（3-3）**で、これが無いと施設は
ただの飾りになり、M4 の目的が達成できない。

---

## 9. 用語集

| 用語 | 意味 |
|---|---|
| チャンク | マップの単位。32×32タイル。開始時は1チャンクだけ解放されている |
| 区画（ゾーン） | プレイヤーが塗る土地の用途。住宅 / 商業 / 工業の3種 |
| footprint | 施設が占有するタイル数。1（1x1）または 4（2x2）。`pos` は左上タイル |
| トリップ | 1回の移動。人流（住宅→商業/工業/施設）と物流（工業→商業） |
| 満足度 | 建物ごとの 0〜100。低い状態が続くと退去する |
| 需要バー（RCI） | 住(R)・商(C)・工(I) の需要。-100〜100 |
| tick | シミュの最小時間単位。10 tick/秒。1日 = 600 tick |
| 決定論 | 同じシード・同じ操作なら必ず同じ結果になること |

---

## 10. この計画の弱いところ（正直に）

**「施設が置く場所を考える楽しさを生むか」は作ってみないと分からない。**
バフの半径と効果量が弱すぎれば「置くだけ」になり、強すぎれば「最適解が一つ」になる。
数値は `balance.ts` にあるので調整はできるが、**どちらに転ぶかは実装前には判断できない**。
だから M4 完了時点でオーナーに触ってもらう段取りを §7 に入れてある。

**もう一つ弱いのは、バフの可視化を M3 に依存させていること。** M3 のインスペクタが
「この建物は公園のバフを受けている」を表示できる設計になっていなければ、M4 の施設は
効果が見えないまま終わる。**M3 の W3b を発注するときに、この依存を伝えること。**
