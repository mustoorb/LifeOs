import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true });
// Everything is bundled (workspace packages and npm dependencies), so the
// output runs with plain `node` and no node_modules — ideal for a slim image.
await build({
  entryPoints: ['src/server.ts', 'src/cli.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // pg's optional native binding is never used.
  external: ['pg-native'],
  // Lets bundled CommonJS dependencies (pg, nodemailer) call require() for Node built-ins.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
