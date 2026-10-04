import { SECOND, type Instant } from '@lifeos/contracts';
import type { ForegroundSample } from '@lifeos/promethee';

export interface Tick {
  readonly now: Instant;
  /** Frontmost app, or null when unknown, locked or asleep. */
  readonly appId: string | null;
  /** Seconds since the last keyboard/mouse input. */
  readonly idleSeconds: number;
}

export interface SamplerOptions {
  readonly idleThresholdSec: number;
  readonly deniedApps: ReadonlySet<string>;
}

/**
 * Holds the most recent samples until they can no longer turn out to be idle.
 *
 * The OS only reports idleness after the fact: at the moment the idle
 * threshold is crossed, the previous `idleThreshold` seconds were already
 * idle. Buffering lets us drop those samples instead of counting a coffee
 * break as work. Idle time itself is never stored: no sample, no session.
 */
export class SampleBuffer {
  private pending: ForegroundSample[] = [];

  constructor(private options: SamplerOptions) {}

  configure(options: SamplerOptions): void {
    this.options = options;
    this.pending = this.pending.filter((sample) => !options.deniedApps.has(sample.appId));
  }

  /** Returns samples that are now settled and safe to persist. */
  tick(input: Tick): ForegroundSample[] {
    const idle = input.idleSeconds >= this.options.idleThresholdSec;
    if (idle) {
      const idleSince = input.now - input.idleSeconds * SECOND;
      // The sample at the moment of the last input is still activity.
      this.pending = this.pending.filter((sample) => sample.at <= idleSince);
    } else if (input.appId && !this.options.deniedApps.has(input.appId)) {
      this.pending.push({ at: input.now, appId: input.appId, idle: false });
    }
    const settledBefore = input.now - this.options.idleThresholdSec * SECOND;
    const ready = this.pending.filter((sample) => sample.at < settledBefore);
    this.pending = this.pending.filter((sample) => sample.at >= settledBefore);
    return ready;
  }

  /** Everything buffered, e.g. when the user pauses or quits while present. */
  drain(): ForegroundSample[] {
    const all = this.pending;
    this.pending = [];
    return all;
  }

  /** Buffered samples, without removing them, for a live view of today. */
  peek(): readonly ForegroundSample[] {
    return this.pending;
  }

  /** Throws away the buffer, e.g. when consent is revoked. */
  discard(): void {
    this.pending = [];
  }

  get size(): number {
    return this.pending.length;
  }
}
