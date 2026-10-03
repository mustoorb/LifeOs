import type { HomeView, RecapView } from '../../server/src/home-types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Same-origin calls only. The session is an HttpOnly cookie the page can't
 * read; the custom header marks requests as coming from this client, which
 * cross-site forms can't forge.
 */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'x-lifeos-client': 'web', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Could not reach LifeOS. Check your connection.');
  }
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const error = (data as { error?: { code: string; message: string } } | undefined)?.error;
    throw new ApiError(response.status, error?.code ?? 'error', error?.message ?? `Request failed (${response.status})`);
  }
  return data as T;
}

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const q = encodeURIComponent;

export type VerifyResult =
  | { status: 'signed_in' }
  | { status: 'registration_required'; registrationToken: string; termsVersion: string };

export type Correction = { kind: 'confirm' } | { kind: 'discard' } | { kind: 'recategorize'; type: string };

export const api = {
  session: () => call<{ signedIn: boolean }>('GET', '/v1/auth/session'),
  startSignIn: (email: string) => call<void>('POST', '/v1/auth/start', { email }),
  verify: (email: string, code: string) => call<VerifyResult>('POST', '/v1/auth/verify', { email, code, deviceLabel: 'LifeOS on the web' }),
  register: (input: { registrationToken: string; accessCode: string; displayName: string; birthDate: string; region: string; acceptedTerms: string }) =>
    call<void>('POST', '/v1/accounts', { ...input, deviceLabel: 'LifeOS on the web' }),
  logout: () => call<void>('POST', '/v1/auth/logout'),
  home: () => call<HomeView>('GET', `/v1/home?tz=${q(tz())}`),
  recap: (week?: string) => call<RecapView>('GET', `/v1/recap?tz=${q(tz())}${week ? `&week=${q(week)}` : ''}`),
  recapFeedback: (week: string, accurate: boolean) => call<void>('PUT', `/v1/recap/${q(week)}/feedback`, { accurate }),
  correct: (activityId: string, correction: Correction) => call<void>('POST', `/v1/me/activities/${q(activityId)}/correction`, correction),
  logManual: (input: { type: string; start: number; end: number; distanceM?: number }) => call<void>('POST', '/v1/me/activity/manual', input),
  addPriority: (text: string, skill: string | null) => call<void>('POST', '/v1/me/priorities', { text, skill }),
  setPriority: (id: string, done: boolean) => call<void>('PATCH', `/v1/me/priorities/${q(id)}`, { done }),
  deletePriority: (id: string) => call<void>('DELETE', `/v1/me/priorities/${q(id)}`),
  skipQuest: (id: string) => call<void>('POST', `/v1/me/quests/${q(id)}/skip`),
};
