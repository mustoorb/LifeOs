import nodemailer, { type Transporter } from 'nodemailer';
import type { Queryable } from './db.js';

/** An error that is safe to show the client, with a stable code and HTTP status. */
export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = () => new AppError(401, 'unauthorized', 'Sign in to continue');
export const forbidden = () => new AppError(403, 'forbidden', 'You do not have access to this');
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const tooMany = () => new AppError(429, 'rate_limited', 'Too many attempts. Try again later.');

// --- mail -------------------------------------------------------------------

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Development only: prints mail to stdout. Config refuses it in production. */
export class ConsoleMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    console.log(`\n[mail] to=${mail.to} subject="${mail.subject}"\n${mail.text}\n`);
  }
}

/** Sends through any SMTP provider. Verified at startup so misconfiguration fails fast. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }

  verify(): Promise<true> {
    return this.transport.verify();
  }

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
  }
}

/** Test mailer that keeps everything it was asked to send. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
  last(to: string): Mail | undefined {
    return this.sent.filter((mail) => mail.to === to).at(-1);
  }
}

// --- rate limiting ----------------------------------------------------------------

/**
 * Fixed-window limiter held in memory. Enough for a single instance; a
 * shared store is needed once the service runs on more than one.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  /** Records an attempt; throws when the key is over its limit. */
  hit(key: string): void {
    const now = this.now();
    const window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 50_000) this.sweep(now);
      return;
    }
    window.count++;
    if (window.count > this.limit) throw tooMany();
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}

// --- audit ------------------------------------------------------------------------

export type Actor = { readonly kind: 'account'; readonly id: string } | { readonly kind: 'system' | 'cli' };

export function actorLabel(actor: Actor): string {
  return actor.kind === 'account' ? `account:${actor.id}` : actor.kind;
}

/** Appends to the audit log. Details must not contain emails or other personal data. */
export async function audit(
  db: Queryable,
  at: number,
  actor: Actor,
  action: string,
  target: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query('INSERT INTO audit_log (at, actor, action, target, details) VALUES ($1, $2, $3, $4, $5)', [
    new Date(at),
    actorLabel(actor),
    action,
    target,
    JSON.stringify(details),
  ]);
}
