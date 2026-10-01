import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { sri } from './build/sri.ts';

// The production security headers live in vercel.json; `vite preview` serves
// the same ones, so a CSP violation shows up locally before it ships.
const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as {
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};
const siteHeaders = Object.fromEntries(
  vercel.headers.find((h) => h.source === '/(.*)')!.headers.map((h) => [h.key, h.value])
);

export default defineConfig({
  plugins: [react(), sri()],
  build: {
    // Every asset is a file: data: URIs would need img-src/font-src data:
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  preview: { headers: siteHeaders },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
