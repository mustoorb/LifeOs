import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ECLIPSE and PROMETHEE stay separately bounded (blueprint §2, §8): ECLIPSE
 * consumes only the shared contracts, never PROMETHEE internals.
 */
describe('product boundary', () => {
  it('ECLIPSE source never imports PROMETHEE', () => {
    const dir = join(import.meta.dirname, '..', 'src');
    const offenders = readdirSync(dir).filter((file) =>
      /from ['"]@lifeos\/promethee/.test(readFileSync(join(dir, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
