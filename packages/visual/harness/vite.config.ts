import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Tiny dev/perf harness for @carbon/visual. Not shipped. */
export default defineConfig({
  root,
  base: './',
  esbuild: { jsx: 'automatic' },
  resolve: { dedupe: ['react', 'react-dom', 'three'] },
  server: { port: 5179, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5180, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 2000 },
});
