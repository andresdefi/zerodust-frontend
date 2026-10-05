import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// Four builds (package.json "build"):
// - offline (--mode offline): everything inlined, made into one HTML file
//   by scripts/make-offline.mjs;
// - site: the app as one script (dynamic imports folded in: browsers cannot
//   check the integrity of a module loaded later) and static assets, with SRI;
// - theme (--mode theme): the static pages' only script, added to dist/;
// - ssr (--ssr src/prerender.tsx): only to render the static pages to HTML.
/** The commit the site was built from, for sweep reports; 'unknown' without git */
function commit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig(({ mode, isSsrBuild }) => {
  const offline = mode === 'offline';
  const theme = mode === 'theme';
  return {
    // The offline file says 'offline' rather than a commit, so its published hash changes only with its content
    define: { __SITE_VERSION__: JSON.stringify(offline ? 'offline' : commit()) },
    plugins: [react(), ...(offline || theme || isSsrBuild ? [] : [sri()])],
    base: offline ? './' : '/',
    resolve: offline
      ? { alias: [{ find: '../chains/logo-src', replacement: fileURLToPath(new URL('./src/chains/logo-src.offline.ts', import.meta.url)) }] }
      : undefined,
    build: offline
      ? {
          outDir: 'dist-offline',
          // Fonts and logos become data: URIs inside the one file
          assetsInlineLimit: 100_000_000,
          cssCodeSplit: false,
          modulePreload: false,
          sourcemap: false,
          chunkSizeWarningLimit: 3000,
          rollupOptions: { output: { inlineDynamicImports: true } },
        }
      : isSsrBuild
        ? { outDir: 'dist-ssr', sourcemap: false }
        : theme
          ? {
              emptyOutDir: false,
              sourcemap: false,
              manifest: 'theme-manifest.json',
              rollupOptions: { input: { theme: 'src/static-theme.ts' } },
            }
          : {
              // Every asset is a file: data: URIs would need img-src/font-src data:
              assetsInlineLimit: 0,
              modulePreload: { polyfill: false },
              sourcemap: false,
              chunkSizeWarningLimit: 1500,
              rollupOptions: { output: { inlineDynamicImports: true } },
            },
    preview: { headers: siteHeaders },
    test: { include: ['tests/**/*.test.ts'], environment: 'node' },
  };
});
