import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../packages/workflow-designer/src', import.meta.url)),
    },
  },
  build: { outDir: 'dist' },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
