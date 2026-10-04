import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseHelperLine, type FrontmostApp } from '../core/helper-protocol.js';

export interface FrontmostDetector {
  current(): FrontmostApp;
  readonly running: boolean;
  start(): void;
  stop(): void;
}

const NONE: FrontmostApp = { bundleId: null, name: null };

/**
 * Runs the native `lifeos-frontmost` helper and keeps the latest frontmost
 * app it reported. If the helper dies it is restarted with backoff; while it
 * is down, `current()` reports no app, so nothing is recorded.
 */
export class HelperDetector implements FrontmostDetector {
  private child: ChildProcess | null = null;
  private latest: FrontmostApp = NONE;
  private stopped = true;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthy = false;

  constructor(
    private readonly command: string,
    private readonly args: readonly string[] = [],
    private readonly onRunningChange: (running: boolean) => void = () => {},
    private readonly maxBackoffMs = 60_000,
  ) {}

  get running(): boolean {
    return this.healthy;
  }

  current(): FrontmostApp {
    return this.healthy ? this.latest : NONE;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
    this.child = null;
    this.setHealthy(false);
  }

  private launch(): void {
    const child = spawn(this.command, this.args, { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    child.on('error', () => this.handleExit(child));
    child.on('exit', () => this.handleExit(child));
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const parsed = parseHelperLine(line);
      if (!parsed) return;
      this.latest = parsed;
      this.failures = 0;
      this.setHealthy(true);
    });
  }

  private handleExit(child: ChildProcess): void {
    if (child !== this.child) return;
    this.child = null;
    this.latest = NONE;
    this.setHealthy(false);
    if (this.stopped) return;
    const delay = Math.min(this.maxBackoffMs, 1_000 * 2 ** this.failures++);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.launch();
    }, delay);
  }

  private setHealthy(healthy: boolean): void {
    if (healthy === this.healthy) return;
    this.healthy = healthy;
    this.onRunningChange(healthy);
  }
}

/**
 * Development stand-in for non-macOS machines: reports a fixed app given as
 * `LIFEOS_DEV_FRONTMOST="bundle.id:Display Name"`.
 */
export class FixedDetector implements FrontmostDetector {
  readonly running = true;
  constructor(private readonly app: FrontmostApp) {}
  current(): FrontmostApp {
    return this.app;
  }
  start(): void {}
  stop(): void {}
}

export function parseDevFrontmost(value: string | undefined): FrontmostApp | null {
  if (!value) return null;
  const [bundleId, ...name] = value.split(':');
  return parseHelperLine(JSON.stringify({ bundleId, name: name.join(':') || bundleId }));
}
