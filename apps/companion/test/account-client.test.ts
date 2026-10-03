import { describe, expect, it } from 'vitest';
import { AccountApiError, AccountClient, validateServerUrl } from '../src/core/account-client.js';

describe('validateServerUrl', () => {
  it('requires HTTPS except on this machine', () => {
    expect(validateServerUrl('https://api.example.com/some/path')).toBe('https://api.example.com');
    expect(validateServerUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(validateServerUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(() => validateServerUrl('http://api.example.com')).toThrow(/HTTPS/);
    expect(() => validateServerUrl('https://user:pass@api.example.com')).toThrow(/credentials/);
    expect(() => validateServerUrl('not a url')).toThrow(/Invalid/);
  });
});

describe('AccountClient', () => {
  const respond = (status: number, body: string) => async () => new Response(body, { status });

  it('sends the bearer token and JSON body', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const client = new AccountClient('https://api.example.com', async (url, init) => {
      seen = { url, ...(init ? { init } : {}) };
      return new Response('{"accepted":1,"duplicates":0,"rejected":[]}', { status: 200 });
    });
    await client.uploadDesktop('lo_s_token', { format: 'lifeos.desktop-activity', version: 1, events: [] });
    expect(seen!.url).toBe('https://api.example.com/v1/me/activity/desktop');
    expect(new Headers(seen!.init!.headers).get('authorization')).toBe('Bearer lo_s_token');
    expect(JSON.parse(String(seen!.init!.body))).toEqual({ format: 'lifeos.desktop-activity', version: 1, events: [] });
  });

  it('turns server errors, odd responses and network failures into friendly errors', async () => {
    const api = (fetch: () => Promise<Response>) => new AccountClient('https://api.example.com', fetch).me('lo_s_x');

    await expect(api(respond(401, '{"error":{"code":"unauthorized","message":"Sign in to continue"}}'))).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'Sign in to continue',
      offline: false,
    });
    await expect(api(respond(502, '<html>Bad gateway</html>'))).rejects.toMatchObject({ status: 502, code: 'http_error', offline: true });
    const failure = await api(async () => {
      throw new TypeError('fetch failed');
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AccountApiError);
    expect(failure).toMatchObject({ status: 0, offline: true, message: expect.stringMatching(/Could not reach LifeOS/) });
  });
});
