import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./packages/workflow-designer/src', import.meta.url)),
      // 与 apps/web/tsconfig.json 的 @bi/* 保持一致，便于单测直接引用仪表板模块
      '@bi': fileURLToPath(new URL('./apps/web/src/features/dashboard', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/**/test/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
  },
});
