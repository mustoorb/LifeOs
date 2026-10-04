export interface Config {
  readonly databaseUrl: string;
  /** Keys the HMAC of sign-in codes. At least 32 characters. */
  readonly secret: string;
  readonly port: number;
  readonly host: string;
  readonly mailer: MailerConfig;
  readonly production: boolean;
  /** Read the client IP from X-Forwarded-For (only behind a trusted proxy). */
  readonly trustProxy: boolean;
}

export type MailerConfig =
  | { readonly kind: 'console' }
  /** Any SMTP provider: `smtps://user:pass@host:465` or `smtp://user:pass@host:587` (STARTTLS). */
  | { readonly kind: 'smtp'; readonly url: string; readonly from: string };

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const production = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');
  const secret = env.LIFEOS_SECRET ?? '';
  if (secret.length < 32) throw new ConfigError('LIFEOS_SECRET must be at least 32 characters');

  const kind = env.LIFEOS_MAILER ?? (env.SMTP_URL ? 'smtp' : 'console');
  let mailer: MailerConfig;
  if (kind === 'smtp') {
    const url = env.SMTP_URL ?? '';
    if (!/^smtps?:\/\//.test(url)) throw new ConfigError('SMTP_URL must start with smtp:// or smtps://');
    const from = env.MAIL_FROM ?? '';
    if (!/@/.test(from)) throw new ConfigError('MAIL_FROM is required, e.g. "LifeOS <hello@your-domain.com>"');
    mailer = { kind: 'smtp', url, from };
  } else if (kind === 'console') {
    // The console mailer prints sign-in codes to the log; that is only acceptable in development.
    if (production) throw new ConfigError('Set SMTP_URL and MAIL_FROM: the console mailer is not allowed with NODE_ENV=production');
    mailer = { kind: 'console' };
  } else {
    throw new ConfigError(`Unknown LIFEOS_MAILER "${kind}"`);
  }

  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError('PORT must be a valid port');
  return {
    databaseUrl,
    secret,
    port,
    host: env.HOST ?? '127.0.0.1',
    mailer,
    production,
    trustProxy: env.LIFEOS_TRUST_PROXY === '1',
  };
}
