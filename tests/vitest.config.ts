import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const web = path.join(root, 'apps/web');

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      // apps/web's own path alias, so its pages/components/routes can be imported as they are.
      { find: /^@\/(.*)$/, replacement: path.join(web, 'src/$1') },
      // One React for the test renderer and the web components.
      { find: /^react$/, replacement: path.join(web, 'node_modules/react') },
      { find: /^react\/(.*)$/, replacement: path.join(web, 'node_modules/react/$1') },
      { find: /^react-dom$/, replacement: path.join(web, 'node_modules/react-dom') },
      { find: /^react-dom\/(.*)$/, replacement: path.join(web, 'node_modules/react-dom/$1') },
    ],
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    server: { deps: { inline: [/apps\/web/, /@solana\/wallet-adapter/] } },
  },
});
