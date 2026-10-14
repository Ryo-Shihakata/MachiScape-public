import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 依存方向（実装書 §1）: ui → render → sim。逆流と横断を禁止する。
 * パス解決に依存しないよう、import 文字列のパターン照合で守る
 * （ネイティブ resolver を持ち込まないため）。
 */
const SIM_FORBIDDEN = ['pixi.js', 'react', 'react-dom', 'zustand', 'idb'];

export default tseslint.config(
  // .claude/worktrees は subagent の作業コピー。走査するとローカルの lint 結果が
  // 他エージェントの作業中の状態に左右されるため必ず除外する
  { ignores: ['dist', 'node_modules', 'coverage', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 決定論と依存ゼロの担保（実装書 §0・§1）
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'performance', message: 'sim は決定論。計測APIに依存してはいけない' },
        { name: 'window', message: 'sim は DOM に依存してはいけない' },
        { name: 'document', message: 'sim は DOM に依存してはいけない' },
        { name: 'Date', message: 'sim は決定論。時刻に依存してはいけない' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'sim は rng.ts のシード付きRNGのみ使う' },
        { object: 'Date', property: 'now', message: 'sim は決定論。時刻に依存してはいけない' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: SIM_FORBIDDEN, message: 'sim は依存ゼロ（実装書 §1）' },
            {
              group: ['**/render/**', '**/ui/**', '**/save/**', '**/audio/**', '@/render*', '@/ui*'],
              message: 'sim は他レイヤに依存してはいけない（依存方向は ui → render → sim）',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/render/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/ui/**', '@/ui*'],
              message: 'render から ui への依存は禁止（依存方向は ui → render → sim）',
            },
          ],
        },
      ],
    },
  },
  {
    // 性能計測のベンチだけは時刻の取得を許す。ファイル名を .bench.test.ts に限定することで
    // sim 本体の決定論ガードは弱めない
    files: ['**/*.bench.test.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-console': 'off',
    },
  },
  {
    // proto/ は P0 試作専用。品質基準の対象外（計画書 §7）
    files: ['proto/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
