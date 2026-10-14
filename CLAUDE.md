# MachiScape

## 概要

Mini Metro / Mini Motorways 系譜のミニマルなまちづくりWebゲーム。道路を引き、区画（住・商・工）を塗り、
個別車両（人・物流）が流れる街を育てる。エンドレス+マイルストーン、ゲームオーバーなし。スマホ優先・無料公開。

- 計画書（要件・スコープ）: `docs/plan.md`
- 実装書（全仕様のSSOT）: `docs/implementation-spec.md` — 実装はこれに従う。矛盾があれば実装書を直してから書く

## 技術スタック

- 言語 / ランタイム: TypeScript (strict), ブラウザのみ（v1はバックエンドなし）
- 描画: Pixi.js v8（WebGL）/ UI: React 19 + Zustand（UI状態のみ）
- ビルド: Vite / テスト: Vitest / パッケージ管理: pnpm
- シミュ本体は `src/sim/`（純TS・依存ゼロ・決定論）。依存方向 `ui → render → sim` を崩さない

## コマンド

| 目的 | コマンド |
|------|----------|
| 依存インストール | `pnpm install` |
| 開発サーバ起動 | `pnpm dev` |
| テスト | `pnpm test` |
| ビルド | `pnpm build` |
| Lint / 型チェック | `pnpm lint` / `pnpm typecheck` |

（M0で雛形を作るまでは未整備）

## 規約・注意点

- バランス数値は `src/sim/balance.ts` に一元化。コードに直書きしない
- `src/sim/` で `Math.random` / `Date` / DOM / Pixi / React を使わない（決定論テストが落ちる）
- ユーザー向け文字列は `src/i18n/ja.ts` 経由。コンポーネントに日本語直書きしない
- `proto/` はP0試作専用。品質基準・デプロイ対象外
- 面白さ判定（P0/M2/M5のプレイテスト）はRyoが行う。agentが自己完結させない
