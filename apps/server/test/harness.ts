import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, migrate, type Db } from '../src/db.js';
import { createApp, createServices, type Services } from '../src/http.js';
import { MemoryMailer } from '../src/support.js';

/**
 * Integration tests need a Postgres server. Set TEST_DATABASE_URL to a
 * connection that may create databases, e.g.
 * postgres://postgres:postgres@127.0.0.1:5432/postgres
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export const T0 = Date.UTC(2026, 9, 5, 9, 0);

export interface Harness {
  readonly db: Db;
  readonly services: Services;
  readonly mailer: MemoryMailer;
  readonly clock: { now: number };
  request(method: string, path: string, options?: { body?: unknown; token?: string; raw?: string }): Promise<Response>;
  json<T = any>(method: string, path: string, options?: { body?: unknown; token?: string }): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const name = `lifeos_test_${randomBytes(6).toString('hex')}`;
  const adminPool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await adminPool.query(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const db = createPool(url.toString());
  await migrate(db);

  const clock = { now: T0 };
  const now = () => clock.now;
  const mailer = new MemoryMailer();
  const services = createServices({ db, mailer, secret: 'test-secret-that-is-at-least-32-characters', now });
  const app = createApp(services, { trustProxy: false, now });

  const request: Harness['request'] = (method, path, options = {}) => {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined || options.raw !== undefined) headers['content-type'] = 'application/json';
    return Promise.resolve(
      app.request(path, {
        method,
        headers,
        ...(options.raw !== undefined ? { body: options.raw } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      }),
    );
  };

  return {
    db,
    services,
    mailer,
    clock,
    request,
    async json(method, path, options) {
      const response = await request(method, path, options);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      await db.end();
      await adminPool.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await adminPool.end();
    },
  };
}

/** Requests a sign-in code and returns it from the captured mail. */
export async function requestCode(h: Harness, email: string): Promise<string> {
  const response = await h.request('POST', '/v1/auth/start', { body: { email } });
  if (response.status !== 202) throw new Error(`auth/start returned ${response.status}: ${await response.text()}`);
  const code = /\b(\d{6})\b/.exec(h.mailer.last(email.toLowerCase())?.text ?? '')?.[1];
  if (!code) throw new Error('No sign-in code was sent');
  return code;
}

export async function issueCode(h: Harness, overrides: Partial<Parameters<Services['admin']['issueCodes']>[1]> = {}): Promise<string> {
  const [code] = await h.services.admin.issueCodes({ kind: 'cli' }, {
    type: 'founding',
    campaign: 'founding',
    count: 1,
    maxRedemptions: 10,
    ...overrides,
  });
  return code!.code;
}

export const ADULT = '1990-04-12';

/** Full sign-up: email code → registration → session token. */
export async function signUp(
  h: Harness,
  email: string,
  accessCode: string,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  const code = await requestCode(h, email);
  const verified = await h.json('POST', '/v1/auth/verify', { body: { email, code, deviceLabel: 'Test Mac' } });
  if (verified.body.status !== 'registration_required') throw new Error(`Expected registration, got ${JSON.stringify(verified.body)}`);
  return h.json('POST', '/v1/accounts', {
    body: {
      registrationToken: verified.body.registrationToken,
      accessCode,
      birthDate: ADULT,
      region: 'fr',
      displayName: 'Ada',
      acceptedTerms: verified.body.termsVersion,
      deviceLabel: 'Test Mac',
      ...overrides,
    },
  });
}

export async function member(h: Harness, email: string): Promise<string> {
  const result = await signUp(h, email, await issueCode(h));
  if (result.status !== 201) throw new Error(`Sign-up failed: ${JSON.stringify(result.body)}`);
  return result.body.token;
}

export async function adminToken(h: Harness, email = 'admin@lifeos.test'): Promise<string> {
  const token = await member(h, email);
  await h.services.admin.setRole({ kind: 'cli' }, email, 'admin');
  return token;
}
