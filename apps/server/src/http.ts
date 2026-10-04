import { CONSENT_SCOPES } from '@lifeos/promethee';
import type { IncomingMessage } from 'node:http';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { AccountService } from './accounts.js';
import { ActivityService, DesktopUpload } from './activity.js';
import { AdminService } from './admin.js';
import { AuthService, SESSION_TTL, type Authenticated } from './auth.js';
import { GameEngine } from './game.js';
import { HomeService, MANUAL_TYPES } from './home.js';
import type { Db } from './db.js';
import { PRIVACY_POLICY_VERSION, PrivacySettings, TERMS_VERSION } from './model.js';
import { SKILLS, type SkillId } from '@lifeos/eclipse';
import { ACTIVITY_TYPES } from '@lifeos/contracts';
import { readWebAssets, type WebAssets } from './web.js';
import { AppError, RateLimiter, forbidden, type Actor, type Mailer } from './support.js';

const HOUR = 60 * 60_000;

export interface Services {
  readonly auth: AuthService;
  readonly accounts: AccountService;
  readonly admin: AdminService;
  readonly activity: ActivityService;
  readonly game: GameEngine;
  readonly home: HomeService;
}

export function createServices(deps: { db: Db; mailer: Mailer; secret: string; now: () => number }): Services {
  const auth = new AuthService(deps);
  const accounts = new AccountService(deps.db, auth, deps.now);
  const game = new GameEngine(deps.db, deps.now);
  return {
    auth,
    accounts,
    admin: new AdminService(deps.db, deps.now),
    activity: new ActivityService(deps.db, accounts, deps.now),
    game,
    home: new HomeService(deps.db, game, deps.now),
  };
}

// --- request schemas ------------------------------------------------------------

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'must not contain control characters');
const deviceLabel = text(60).default('Unknown device');
const instant = z.number().int().nonnegative();

const StartSignIn = z.object({ email: z.string().max(254) });
const VerifySignIn = z.object({ email: z.string().max(254), code: z.string().max(10), deviceLabel });
const Register = z.object({
  registrationToken: z.string().max(100),
  accessCode: z.string().max(20),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  region: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase()),
  displayName: text(40),
  acceptedTerms: z.string().max(40),
  deviceLabel,
});
const UpdateProfile = z
  .object({ displayName: text(40).optional(), privacy: PrivacySettings.partial().optional() })
  .refine((value) => value.displayName !== undefined || value.privacy !== undefined, 'nothing to update');
const DeleteAccount = z.object({ confirmEmail: z.string().max(254) });
const SetConsent = z.object({ granted: z.boolean() });
const SetOptIn = z.object({ leaderboardOptIn: z.boolean() });
const Range = z.object({ from: z.coerce.number().int().nonnegative(), to: z.coerce.number().int().positive() });
const IssueCodes = z.object({
  type: z.enum(['founding', 'partner', 'staff', 'recovery']),
  campaign: z.string().max(42),
  count: z.number().int().min(1).max(500),
  maxRedemptions: z.number().int().min(1).max(10_000),
  expiresAt: instant.optional(),
  minAge: z.number().int().min(18).max(120).optional(),
  regions: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(50).optional(),
});
const CreateSeason = z.object({
  id: z.string().max(42),
  name: text(80),
  startsAt: instant,
  endsAt: instant,
  campaigns: z.array(z.string().max(42)).min(1).max(20),
  xpRulesetVersion: z.string().min(1).max(40),
});
const SetRole = z.object({ role: z.enum(['member', 'admin']) });
const Correct = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('confirm') }),
  z.object({ kind: z.literal('discard') }),
  z.object({ kind: z.literal('recategorize'), type: z.enum(ACTIVITY_TYPES) }),
]);
const ManualLog = z.object({
  type: z.enum(MANUAL_TYPES),
  start: instant,
  end: instant,
  distanceM: z.number().nonnegative().max(1_000_000).optional(),
});
const AddPriority = z.object({ text: text(120), skill: z.enum(SKILLS as [SkillId, ...SkillId[]]).nullable().default(null) });
const SetDone = z.object({ done: z.boolean() });
const WeekQuery = z.object({ week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), tz: z.string().max(64).optional() });
const Feedback = z.object({ accurate: z.boolean() });

/** The web client's session cookie: HttpOnly, never readable by page scripts. */
export const SESSION_COOKIE = 'lifeos_session';
/** Header the web client sends; cross-site forms can't, so it blocks CSRF on cookie-authenticated writes. */
export const CLIENT_HEADER = 'x-lifeos-client';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
  throw new AppError(422, 'invalid_request', detail);
}

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError(400, 'invalid_json', 'Request body must be JSON');
  }
}

// --- app ------------------------------------------------------------------------

type Env = {
  Bindings: { incoming?: IncomingMessage };
  Variables: { auth: Authenticated };
};

export interface HttpOptions {
  readonly trustProxy: boolean;
  readonly now: () => number;
  /** Mark cookies Secure (HTTPS deployments). */
  readonly secureCookies?: boolean;
  /** Built web client to serve at `/`, if any. */
  readonly webDir?: string;
}

export function createApp(services: Services, options: HttpOptions): Hono<Env> {
  const { auth, accounts, admin, activity, game, home } = services;
  const web: WebAssets | null = options.webDir ? readWebAssets(options.webDir) : null;
  const isWeb = (c: Context<Env>) => c.req.header(CLIENT_HEADER) === 'web';
  /** Web sign-ins get the token as a cookie instead of in the body. */
  const signedIn = (c: Context<Env>, token: string, account: unknown, status: 200 | 201) => {
    if (!isWeb(c)) return c.json({ status: 'signed_in', token, account }, status);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: options.secureCookies ?? false,
      path: '/',
      maxAge: Math.floor(SESSION_TTL / 1000),
    });
    return c.json({ status: 'signed_in', account }, status);
  };
  const app = new Hono<Env>();
  const signInStarts = new RateLimiter(20, HOUR, options.now);
  const signInVerifies = new RateLimiter(60, HOUR, options.now);
  const registrations = new RateLimiter(20, HOUR, options.now);

  const clientIp = (c: Context<Env>): string => {
    if (options.trustProxy) {
      // Our proxy appends the address it saw, so the last entry is the one we can trust;
      // anything before it came from the client and may be forged.
      const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
      if (forwarded) return forwarded;
    }
    return c.env?.incoming?.socket?.remoteAddress ?? 'unknown';
  };

  app.use('*', secureHeaders());
  app.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: () => { throw new AppError(413, 'too_large', 'Request body is too large'); } }));

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error('[server]', error);
    return c.json({ error: { code: 'internal', message: 'Something went wrong' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404));

  // --- public ---
  app.get('/v1/health', (c) => c.json({ ok: true }));
  app.get('/v1/terms', (c) => c.json({ termsVersion: TERMS_VERSION, privacyPolicyVersion: PRIVACY_POLICY_VERSION }));

  app.post('/v1/auth/start', async (c) => {
    signInStarts.hit(clientIp(c));
    const { email } = parse(StartSignIn, await body(c));
    await auth.startSignIn(email);
    return c.json({ ok: true }, 202);
  });

  app.post('/v1/auth/verify', async (c) => {
    signInVerifies.hit(clientIp(c));
    const input = parse(VerifySignIn, await body(c));
    const result = await auth.verify(input.email, input.code, input.deviceLabel);
    return result.kind === 'session'
      ? signedIn(c, result.token, result.account, 200)
      : c.json({ status: 'registration_required', registrationToken: result.registrationToken, termsVersion: TERMS_VERSION });
  });

  app.post('/v1/accounts', async (c) => {
    registrations.hit(clientIp(c));
    const result = await accounts.register(parse(Register, await body(c)));
    return signedIn(c, result.token, result.account, 201);
  });

  // Lets the web client ask "am I signed in?" without provoking a 401.
  app.get('/v1/auth/session', async (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') || getCookie(c, SESSION_COOKIE);
    try {
      const { account } = await auth.authenticate(token);
      return c.json({ signedIn: true, displayName: account.displayName });
    } catch {
      return c.json({ signedIn: false });
    }
  });

  // --- signed in ---
  const requireAuth = async (c: Context<Env>, next: () => Promise<void>) => {
    const header = c.req.header('authorization');
    let token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      token = getCookie(c, SESSION_COOKIE);
      const safe = c.req.method === 'GET' || c.req.method === 'HEAD';
      if (token && !safe && !isWeb(c)) throw new AppError(403, 'csrf', 'Missing client header');
    }
    c.set('auth', await auth.authenticate(token));
    await next();
  };
  const requireAdmin = async (c: Context<Env>, next: () => Promise<void>) => {
    if (c.var.auth.account.role !== 'admin') throw forbidden();
    await next();
  };
  app.use('/v1/auth/logout', requireAuth);
  app.use('/v1/me', requireAuth);
  app.use('/v1/me/*', requireAuth);
  app.use('/v1/admin/*', requireAuth, requireAdmin);
  app.use('/v1/home', requireAuth);
  app.use('/v1/recap', requireAuth);
  app.use('/v1/recap/*', requireAuth);

  const accountId = (c: Context<Env>) => c.var.auth.account.id;
  const actorOf = (c: Context<Env>): Actor => ({ kind: 'account', id: accountId(c) });

  app.post('/v1/auth/logout', async (c) => {
    await auth.revokeSession(accountId(c), c.var.auth.sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });
  app.get('/v1/me', async (c) => c.json(await accounts.profile(accountId(c))));
  app.patch('/v1/me', async (c) => c.json(await accounts.updateProfile(accountId(c), parse(UpdateProfile, await body(c)))));
  app.delete('/v1/me', async (c) => {
    const { confirmEmail } = parse(DeleteAccount, await body(c));
    await accounts.deleteAccount(c.var.auth.account, confirmEmail);
    return c.body(null, 204);
  });
  app.get('/v1/me/export', async (c) => {
    const sessions = await auth.listSessions(accountId(c), c.var.auth.sessionId);
    c.header('content-disposition', 'attachment; filename="lifeos-account-export.json"');
    return c.json(await accounts.exportData(accountId(c), sessions));
  });
  app.get('/v1/me/sessions', async (c) => c.json(await auth.listSessions(accountId(c), c.var.auth.sessionId)));
  app.delete('/v1/me/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'Session not found');
    await auth.revokeSession(accountId(c), id);
    return c.body(null, 204);
  });
  app.get('/v1/me/consents', async (c) => c.json(await accounts.consents(accountId(c))));
  app.put('/v1/me/consents/:scope', async (c) => {
    const scope = parse(z.enum(CONSENT_SCOPES), c.req.param('scope'));
    const { granted } = parse(SetConsent, await body(c));
    return c.json(await accounts.setConsent(accountId(c), scope, granted));
  });
  app.put('/v1/me/enrollments/:seasonId', async (c) => {
    const { leaderboardOptIn } = parse(SetOptIn, await body(c));
    return c.json(await accounts.setLeaderboardOptIn(accountId(c), c.req.param('seasonId'), leaderboardOptIn));
  });
  app.get('/v1/me/invites', async (c) => c.json(await accounts.listInvites(accountId(c))));
  app.post('/v1/me/invites', async (c) => c.json(await accounts.issueInvite(c.var.auth.account), 201));
  app.post('/v1/me/activity/desktop', async (c) => {
    const result = await activity.ingestDesktop(c.var.auth.account, parse(DesktopUpload, await body(c)));
    if (result.accepted > 0) await game.refresh(accountId(c));
    return c.json(result);
  });
  app.get('/v1/me/activity', async (c) => {
    const range = parse(Range, c.req.query());
    return c.json(await activity.list(accountId(c), range.from, range.to));
  });
  app.delete('/v1/me/activity', async (c) => {
    const range = parse(Range, c.req.query());
    const deleted = await activity.deleteRange(accountId(c), range.from, range.to);
    if (deleted > 0) await game.refresh(accountId(c));
    return c.json({ deleted });
  });

  // --- ECLIPSE home ---
  app.get('/v1/home', async (c) => {
    const { tz } = parse(WeekQuery, c.req.query());
    return c.json(await home.home(await home.useTimeZone(c.var.auth.account, tz)));
  });
  app.post('/v1/me/activities/:id/correction', async (c) => {
    await home.correct(c.var.auth.account, c.req.param('id'), parse(Correct, await body(c)));
    return c.body(null, 204);
  });
  app.post('/v1/me/activity/manual', async (c) => {
    const input = parse(ManualLog, await body(c));
    await home.logManual(c.var.auth.account, {
      type: input.type,
      start: input.start,
      end: input.end,
      ...(input.distanceM !== undefined ? { distanceM: input.distanceM } : {}),
    });
    return c.body(null, 201);
  });
  app.post('/v1/me/priorities', async (c) => {
    const input = parse(AddPriority, await body(c));
    await home.addPriority(c.var.auth.account, input.text, input.skill);
    return c.body(null, 201);
  });
  app.patch('/v1/me/priorities/:id', async (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'Priority not found');
    await home.setPriorityDone(accountId(c), id, parse(SetDone, await body(c)).done);
    return c.body(null, 204);
  });
  app.delete('/v1/me/priorities/:id', async (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'Priority not found');
    await home.deletePriority(accountId(c), id);
    return c.body(null, 204);
  });
  app.post('/v1/me/quests/:id/skip', async (c) => {
    await home.skipQuest(c.var.auth.account, c.req.param('id'));
    return c.body(null, 204);
  });
  app.get('/v1/recap', async (c) => {
    const query = parse(WeekQuery, c.req.query());
    const account = await home.useTimeZone(c.var.auth.account, query.tz);
    return c.json(await home.recap(account, query.week));
  });
  app.put('/v1/recap/:week/feedback', async (c) => {
    const week = c.req.param('week');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new AppError(404, 'not_found', 'Week not found');
    await home.recapFeedback(c.var.auth.account, week, parse(Feedback, await body(c)).accurate);
    return c.body(null, 204);
  });

  // --- web client ---
  if (web) {
    for (const [path, asset] of web.files) {
      app.get(path, (c) => {
        c.header('content-type', asset.type);
        c.header('cache-control', path === '/' ? 'no-cache' : 'public, max-age=300');
        if (asset.type.startsWith('text/html')) c.header('content-security-policy', web.csp);
        return c.body(asset.body);
      });
    }
  }

  // --- admin ---
  app.get('/v1/admin/access-codes', async (c) => c.json(await admin.listCodes(c.req.query('campaign'))));
  app.post('/v1/admin/access-codes', async (c) => c.json(await admin.issueCodes(actorOf(c), parse(IssueCodes, await body(c))), 201));
  app.post('/v1/admin/access-codes/:code/revoke', async (c) => c.json(await admin.revokeCode(actorOf(c), c.req.param('code'))));
  app.get('/v1/admin/seasons', async (c) => c.json(await admin.listSeasons()));
  app.post('/v1/admin/seasons', async (c) => c.json(await admin.createSeason(actorOf(c), parse(CreateSeason, await body(c))), 201));
  app.get('/v1/admin/accounts', async (c) => {
    const query = parse(z.object({ limit: z.coerce.number().int().default(100), offset: z.coerce.number().int().default(0) }), c.req.query());
    return c.json(await admin.listAccounts(query.limit, query.offset));
  });
  app.put('/v1/admin/accounts/:id/role', async (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'Account not found');
    await admin.setRole(actorOf(c), id, parse(SetRole, await body(c)).role);
    return c.body(null, 204);
  });
  app.get('/v1/admin/audit', async (c) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().default(100) }), c.req.query());
    return c.json(await admin.auditLog(limit));
  });

  return app;
}
