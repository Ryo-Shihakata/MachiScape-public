import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('./src', import.meta.url));

// proto/ は P0 試作専用。本番ビルド（pnpm build）には含めない。
// 試作は pnpm dev で /proto/<name>/ を開いて確認する（計画書 §7）。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': src },
  },
  test: {
    globals: true,
    environment: 'node',
    // proto 本体は試作なのでテストしないが、proto/shared は3方式の比較の公平性を
    // 支える共通契約なのでテスト対象に含める
    include: ['src/**/*.test.ts', 'proto/shared/**/*.test.ts'],
  },
});
