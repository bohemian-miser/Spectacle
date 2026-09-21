import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client lives in `client/`; the built bundle lands in `dist/` where the
// game server (`server/index.ts`) serves it next to the WebSocket endpoint.
// In dev, Vite proxies `/ws` to the tsx-run server on :8787.
export default defineConfig({
  root: 'client',
  // '/' when the game server serves the client; '/Spectacle/' for GitHub Pages.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    minify: false,
  },
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
