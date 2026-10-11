import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The pnpm workspace root (docs/ and packages/ live there).
  outputFileTracingRoot: path.join(here, '../..'),
  outputFileTracingIncludes: { '/how': ['../../docs/how.md'] },
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@carbon/core', '@carbon/agents', '@carbon/x'],
  // Node-only deps stay external on the server.
  serverExternalPackages: ['pg', 'ioredis', '@google/genai', '@anthropic-ai/sdk', 'pngjs', 'jpeg-js'],
  webpack(config) {
    // Workspace sources import './x.js' for './x.ts' (ESM + TypeScript convention).
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'], '.mjs': ['.mts', '.mjs'] };
    // core's migrate() locates its .sql files with new URL('./migrations/', import.meta.url).
    // The web app never migrates (the worker does), so webpack must not treat it as an asset.
    config.module.rules.push({ test: /packages[\\/]core[\\/]src[\\/]bus[\\/]migrate\.ts$/, parser: { url: false } });
    return config;
  },
  async headers() {
    return [
      {
        // The player card is framed by X and others; every other page refuses framing.
        source: '/embed/:path*',
        headers: [{ key: 'Content-Security-Policy', value: 'frame-ancestors *' }],
      },
      {
        source: '/((?!embed/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default nextConfig;
