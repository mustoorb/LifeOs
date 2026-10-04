import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

export const FONTS = [
  ['urbanist', 'urbanist-latin-300-normal.woff2', 'urbanist-300.woff2'],
  ['urbanist', 'urbanist-latin-400-normal.woff2', 'urbanist-400.woff2'],
  ['urbanist', 'urbanist-latin-500-normal.woff2', 'urbanist-500.woff2'],
  ['urbanist', 'urbanist-latin-600-normal.woff2', 'urbanist-600.woff2'],
  ['urbanist', 'urbanist-latin-700-normal.woff2', 'urbanist-700.woff2'],
  ['doto', 'doto-latin-700-normal.woff2', 'doto-700.woff2'],
];

const outdir = new URL('./dist/', import.meta.url).pathname;
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: ['src/app.ts'],
  outfile: 'dist/app.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  logLevel: 'info',
});
await cp('src/index.html', 'dist/index.html');
await cp('src/styles.css', 'dist/styles.css');

// Self-hosted fonts (SIL Open Font License), so the page loads nothing from other sites.
for (const [pkg, file, as] of FONTS) {
  await cp(new URL(`../../node_modules/@fontsource/${pkg}/files/${file}`, import.meta.url), `dist/${as}`);
}
