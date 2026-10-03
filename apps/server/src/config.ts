export interface Config {
  readonly databaseUrl: string;
  /** Keys the HMAC of sign-in codes. At least 32 characters. */
  readonly secret: string;
  readonly port: number;
  readonly host: string;
  readonly mailer: 'console';
  readonly production: boolean;
  /** Read the client IP from X-Forwarded-For (only behind a trusted proxy). */
  readonly trustProxy: boolean;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const production = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');
  const secret = env.LIFEOS_SECRET ?? '';
  if (secret.length < 32) throw new ConfigError('LIFEOS_SECRET must be at least 32 characters');

  const mailer = env.LIFEOS_MAILER ?? 'console';
  if (mailer !== 'console') throw new ConfigError(`Unknown LIFEOS_MAILER "${mailer}"`);
  if (production) {
    // The console mailer prints sign-in codes to the log; that is only acceptable in development.
    throw new ConfigError('No production mailer is configured yet; refusing to start with NODE_ENV=production');
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
