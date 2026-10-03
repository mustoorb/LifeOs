import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WebAssets {
  readonly files: ReadonlyMap<string, { readonly type: string; readonly body: string }>;
  readonly csp: string;
}

/** Fixed routes only: nothing from the request ever becomes a file path. */
const ROUTES: readonly [route: string, file: string, type: string][] = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
];

/** Loads the built web client into memory. Returns null if it hasn't been built. */
export function readWebAssets(dir: string): WebAssets | null {
  if (!existsSync(join(dir, 'index.html'))) return null;
  const files = new Map<string, { type: string; body: string }>();
  for (const [route, file, type] of ROUTES) {
    const path = join(dir, file);
    if (existsSync(path)) files.set(route, { type, body: readFileSync(path, 'utf8') });
  }
  return {
    files,
    csp: [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  };
}
