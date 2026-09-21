import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// Static wallet UI with an optional local worker engine and host connection mode.
export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/browser-config': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/transport': { target: 'http://127.0.0.1:8787', changeOrigin: false, ws: true },
    },
    fs: { allow: ['..'] },
    watch: { useFsEvents: false, usePolling: true },
  },
  worker: { format: 'es' },
  plugins: [vinext(), sites()],
});
