import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const outdir = new URL('./dist/', import.meta.url).pathname;
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const shared = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'info' };
// The LifeOS server this build talks to. Must be HTTPS except for localhost.
const serverUrl = process.env.LIFEOS_SERVER_URL ?? 'http://127.0.0.1:8787';

await Promise.all([
  // Main process: the workspace packages are bundled in, so the app ships no node_modules.
  build({
    ...shared,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main.cjs',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    define: { __LIFEOS_SERVER_URL__: JSON.stringify(serverUrl) },
  }),
  // Sandboxed preloads must be CommonJS.
  build({ ...shared, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...shared, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife' }),
]);
await cp('src/renderer/index.html', 'dist/renderer/index.html');
await cp('src/renderer/styles.css', 'dist/renderer/styles.css');
