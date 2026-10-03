import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const outdir = new URL('./dist/', import.meta.url).pathname;
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const shared = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'info' };

await Promise.all([
  // Main process: the workspace packages are bundled in, so the app ships no node_modules.
  build({ ...shared, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', external: ['electron'] }),
  // Sandboxed preloads must be CommonJS.
  build({ ...shared, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...shared, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife' }),
]);
await cp('src/renderer/index.html', 'dist/renderer/index.html');
await cp('src/renderer/styles.css', 'dist/renderer/styles.css');
