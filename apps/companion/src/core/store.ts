import { DAY, localDateKey, type Interval } from '@lifeos/contracts';
import type { ForegroundSample } from '@lifeos/promethee';
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SAMPLE_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Local-first storage on the user's Mac (blueprint §8, §18.6). Raw samples
 * live in one JSON-lines file per local day under a directory only the user
 * can read. Nothing here talks to the network.
 */
export class LocalStore {
  private readonly samplesDir: string;

  constructor(
    readonly dir: string,
    private readonly timeZone: () => string,
  ) {
    this.samplesDir = join(dir, 'samples');
  }

  async init(): Promise<void> {
    await mkdir(this.samplesDir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    await chmod(this.samplesDir, 0o700);
  }

  async appendSamples(samples: readonly ForegroundSample[]): Promise<void> {
    const byDay = new Map<string, string[]>();
    for (const sample of samples) {
      const key = localDateKey(sample.at, this.timeZone());
      byDay.set(key, [...(byDay.get(key) ?? []), JSON.stringify({ t: sample.at, a: sample.appId })]);
    }
    for (const [key, lines] of byDay) {
      await appendFile(this.samplePath(key), `${lines.join('\n')}\n`, { mode: 0o600 });
    }
  }

  async readSamples(range: Interval): Promise<ForegroundSample[]> {
    const samples: ForegroundSample[] = [];
    for (const key of await this.sampleKeysNear(range)) {
      for (const sample of await this.readDay(key)) {
        if (sample.at >= range.start && sample.at < range.end) samples.push(sample);
      }
    }
    return samples.sort((a, b) => a.at - b.at);
  }

  /** Deletes every sample inside `range` ("delete last hour/day"). */
  async forgetRange(range: Interval): Promise<number> {
    return this.rewriteSamples(await this.sampleKeysNear(range), (s) => s.at < range.start || s.at >= range.end);
  }

  /** Deletes every sample for one app, e.g. when the user excludes it. */
  async forgetApp(appId: string): Promise<number> {
    return this.rewriteSamples(await this.sampleKeys(), (s) => s.appId !== appId);
  }

  /** Deletes raw samples from days before `cutoffKey` (retention). */
  async pruneBefore(cutoffKey: string): Promise<number> {
    const stale = (await this.sampleKeys()).filter((key) => key < cutoffKey);
    await Promise.all(stale.map((key) => rm(this.samplePath(key), { force: true })));
    return stale.length;
  }

  async forgetAllSamples(): Promise<void> {
    await rm(this.samplesDir, { recursive: true, force: true });
    await this.init();
  }

  async readJson(name: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.dir, name), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** Atomic write: a crash leaves either the old or the new file, never half of one. */
  async writeJson(name: string, value: unknown): Promise<void> {
    const target = join(this.dir, name);
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, target);
  }

  async sampleKeys(): Promise<string[]> {
    const files = await readdir(this.samplesDir).catch(() => [] as string[]);
    return files.flatMap((file) => SAMPLE_FILE.exec(file)?.[1] ?? []).sort();
  }

  private async sampleKeysNear(range: Interval): Promise<string[]> {
    // Files are keyed by the zone in effect when written, so look a day either side.
    const wanted = new Set<string>();
    for (let at = range.start - DAY; at <= range.end + DAY; at += DAY / 2) {
      wanted.add(localDateKey(at, this.timeZone()));
    }
    return (await this.sampleKeys()).filter((key) => wanted.has(key));
  }

  private async readDay(key: string): Promise<ForegroundSample[]> {
    const text = await readFile(this.samplePath(key), 'utf8').catch(() => '');
    const samples: ForegroundSample[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const { t, a } = JSON.parse(line) as { t: unknown; a: unknown };
        if (typeof t === 'number' && typeof a === 'string') samples.push({ at: t, appId: a, idle: false });
      } catch {
        // A torn final line after a crash: skip it.
      }
    }
    return samples;
  }

  private async rewriteSamples(keys: readonly string[], keep: (sample: ForegroundSample) => boolean): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      const samples = await this.readDay(key);
      const kept = samples.filter(keep);
      if (kept.length === samples.length) continue;
      removed += samples.length - kept.length;
      const path = this.samplePath(key);
      if (kept.length === 0) {
        await rm(path, { force: true });
        continue;
      }
      const temp = `${path}.tmp`;
      const body = kept.map((sample) => JSON.stringify({ t: sample.at, a: sample.appId })).join('\n');
      await writeFile(temp, `${body}\n`, { mode: 0o600 });
      await rename(temp, path);
    }
    return removed;
  }

  private samplePath(key: string): string {
    return join(this.samplesDir, `${key}.jsonl`);
  }
}
