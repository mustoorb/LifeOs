import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

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
