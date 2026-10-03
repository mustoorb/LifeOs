import { isBundleId } from './settings.js';

/**
 * One line of output from the native `lifeos-frontmost` helper. The helper
 * reports only the frontmost app's bundle id and display name; it has no
 * access to window titles or content, and needs no macOS privacy permission.
 */
export interface FrontmostApp {
  readonly bundleId: string | null;
  readonly name: string | null;
}

const MAX_LINE = 1024;

export function parseHelperLine(line: string): FrontmostApp | null {
  if (line.length === 0 || line.length > MAX_LINE) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const { bundleId, name } = value as Record<string, unknown>;
  return {
    bundleId: isBundleId(bundleId) ? bundleId : null,
    name: typeof name === 'string' && name.length > 0 ? name.slice(0, 120) : null,
  };
}
