import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true });
// Workspace packages (TypeScript sources) are bundled in; npm dependencies stay external.
await build({
  entryPoints: ['src/server.ts', 'src/cli.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['pg', 'hono', 'hono/*', '@hono/node-server', '@hono/node-server/*', 'zod'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
