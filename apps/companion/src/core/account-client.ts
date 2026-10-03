import type { DesktopExport } from './export.js';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A failed API call. `status` 0 means the server could not be reached. */
export class AccountApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  get offline(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface RemoteAccount {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

export type VerifyResponse =
  | { readonly status: 'signed_in'; readonly token: string; readonly account: RemoteAccount }
  | { readonly status: 'registration_required'; readonly registrationToken: string; readonly termsVersion: string };

export interface RegisterRequest {
  readonly registrationToken: string;
  readonly accessCode: string;
  readonly birthDate: string;
  readonly region: string;
  readonly displayName: string;
  readonly acceptedTerms: string;
  readonly deviceLabel: string;
}

export interface UploadResult {
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: readonly { readonly sourceEventId: string; readonly reason: string }[];
}

/** Server limit per upload request. */
export const MAX_EVENTS_PER_UPLOAD = 2000;

/**
 * Talks to the LifeOS server. Runs in the companion's main process only;
 * the window never touches the network.
 */
export class AccountClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: Fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  startSignIn(email: string): Promise<void> {
    return this.call('POST', '/v1/auth/start', { body: { email } });
  }

  verify(email: string, code: string, deviceLabel: string): Promise<VerifyResponse> {
    return this.call('POST', '/v1/auth/verify', { body: { email, code, deviceLabel } });
  }

  register(request: RegisterRequest): Promise<{ token: string; account: RemoteAccount }> {
    return this.call('POST', '/v1/accounts', { body: request });
  }

  me(token: string): Promise<RemoteAccount> {
    return this.call('GET', '/v1/me', { token });
  }

  logout(token: string): Promise<void> {
    return this.call('POST', '/v1/auth/logout', { token });
  }

  setConsent(token: string, scope: 'desktop_activity', granted: boolean): Promise<void> {
    return this.call('PUT', `/v1/me/consents/${scope}`, { token, body: { granted } });
  }

  uploadDesktop(token: string, payload: Pick<DesktopExport, 'format' | 'version' | 'events'>): Promise<UploadResult> {
    return this.call('POST', '/v1/me/activity/desktop', { token, body: payload });
  }

  deleteActivity(token: string, from: number, to: number): Promise<{ deleted: number }> {
    return this.call('DELETE', `/v1/me/activity?from=${Math.max(0, Math.floor(from))}&to=${Math.ceil(to)}`, { token });
  }

  private async call<T>(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl).toString(), {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AccountApiError(0, 'offline', 'Could not reach LifeOS. Check your connection and try again.');
    }

    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body (e.g. a proxy error page).
    }
    if (!response.ok) {
      const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new AccountApiError(
        response.status,
        error?.code ?? 'http_error',
        error?.message ?? `LifeOS responded with ${response.status}.`,
      );
    }
    return data as T;
  }
}

/** Only HTTPS, or plain HTTP to this machine for development. */
export function validateServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid server URL "${raw}"`);
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('The LifeOS server must use HTTPS');
  }
  if (url.username || url.password) throw new Error('The server URL must not contain credentials');
  return url.origin;
}
