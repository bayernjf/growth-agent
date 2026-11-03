import { describe, expect, it } from 'vitest';
import {
  GSC_READONLY_SCOPE,
  buildConsentUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  startLocalCodeReceiver,
  toTokenRecord,
} from '../../src/connector/gsc/oauth.js';
import { GrowthAgentError } from '../../src/errors.js';

type CapturingFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function fakeTokenEndpoint(
  status: number,
  body: unknown,
): { fetchImpl: CapturingFetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl: CapturingFetch = async (url, init) => {
    seen.push(`${url} ${init?.method ?? 'GET'} ${typeof init?.body === 'string' ? init.body : ''}`);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, seen };
}

const deps = { clientId: 'cid', clientSecret: 'csec' };

describe('GSC OAuth installed-app flow (T-B2; NOT hit against real Google yet)', () => {
  it('consent URL is strictly read-only, offline access, forces consent', () => {
    const url = buildConsentUrl({
      clientId: 'cid-123',
      redirectUri: 'http://127.0.0.1:43121/callback',
      state: 'st-abc',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBe(GSC_READONLY_SCOPE);
    expect(parsed.searchParams.get('scope')).not.toContain('write');
    expect(parsed.searchParams.get('client_id')).toBe('cid-123');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:43121/callback');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('state')).toBe('st-abc');
  });

  it('loopback receiver captures the redirect code and serves a close-tab page', async () => {
    const receiver = await startLocalCodeReceiver();
    try {
      const res = await fetch(
        `http://127.0.0.1:${receiver.port}/?code=oauth-code-1&state=st-xyz`,
      );
      expect(res.status).toBe(200);
      const received = await receiver.waitForCode();
      expect(received).toEqual({ code: 'oauth-code-1', state: 'st-xyz' });
    } finally {
      await receiver.close();
    }
  });

  it('loopback receiver rejects with GSC_AUTH_REVOKED when Google returns error=', async () => {
    const receiver = await startLocalCodeReceiver();
    try {
      // Attach the handler BEFORE hitting the route so the rejection is
      // observed, not an unhandled rejection.
      const pending = receiver.waitForCode();
      await fetch(`http://127.0.0.1:${receiver.port}/?error=access_denied`);
      await expect(pending).rejects.toMatchObject({
        code: 'GSC_AUTH_REVOKED',
      });
    } finally {
      await receiver.close();
    }
  });

  // Review F-08: the redirect's state was captured but never compared against
  // the value sent in buildConsentUrl. waitForCode(expectedState) now enforces
  // the OAuth baseline CSRF check.
  it('rejects the code when the callback state does not match the expected state', async () => {
    const receiver = await startLocalCodeReceiver();
    try {
      const pending = receiver.waitForCode('st-expected');
      await fetch(`http://127.0.0.1:${receiver.port}/?code=oauth-code-2&state=st-WRONG`);
      await expect(pending).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    } finally {
      await receiver.close();
    }
  });

  it('accepts the code when the callback state matches the expected state', async () => {
    const receiver = await startLocalCodeReceiver();
    try {
      const pending = receiver.waitForCode('st-expected');
      await fetch(`http://127.0.0.1:${receiver.port}/?code=oauth-code-3&state=st-expected`);
      await expect(pending).resolves.toEqual({ code: 'oauth-code-3', state: 'st-expected' });
    } finally {
      await receiver.close();
    }
  });

  it('code exchange posts the authorization_code grant at the token endpoint', async () => {
    const { fetchImpl, seen } = fakeTokenEndpoint(200, {
      access_token: 'at-new',
      expires_in: 3600,
      refresh_token: 'rt-new',
      scope: GSC_READONLY_SCOPE,
      token_type: 'Bearer',
    });
    const set = await exchangeCodeForToken(
      { ...deps, fetchImpl, tokenEndpoint: 'https://token.test/token' },
      { code: 'code-1', redirectUri: 'http://127.0.0.1:1/cb' },
    );
    expect(set.accessToken).toBe('at-new');
    expect(set.refreshToken).toBe('rt-new');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('grant_type=authorization_code');
    expect(seen[0]).toContain('code=code-1');
    expect(seen[0]).toContain('redirect_uri=');
  });

  it('rejects missing client config before any network call', async () => {
    await expect(
      exchangeCodeForToken({ clientId: '', clientSecret: '' }, { code: 'x', redirectUri: 'y' }),
    ).rejects.toMatchObject({ code: 'GSC_CREDENTIAL_MISSING' });
  });

  it('maps invalid_grant (revoked code) to GSC_AUTH_REVOKED 401 non-retryable', async () => {
    const { fetchImpl } = fakeTokenEndpoint(400, {
      error: 'invalid_grant',
      error_description: 'Code was already redeemed',
    });
    try {
      await exchangeCodeForToken({ ...deps, fetchImpl }, { code: 'bad', redirectUri: 'y' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GrowthAgentError);
      expect((err as GrowthAgentError).code).toBe('GSC_AUTH_REVOKED');
      expect((err as GrowthAgentError).status).toBe(401);
      expect((err as GrowthAgentError).retryable).toBe(false);
    }
  });

  it('refresh posts grant_type=refresh_token and tolerates Google not rotating it', async () => {
    const { fetchImpl, seen } = fakeTokenEndpoint(200, {
      access_token: 'at-refreshed',
      expires_in: 3600,
    });
    const set = await refreshAccessToken({ ...deps, fetchImpl }, 'rt-existing');
    expect(set.accessToken).toBe('at-refreshed');
    expect(set.refreshToken).toBeUndefined();
    expect(seen[0]).toContain('grant_type=refresh_token');
    expect(seen[0]).toContain('refresh_token=rt-existing');
  });

  it('toTokenRecord keeps the previous refresh token when Google did not rotate it', () => {
    const record = toTokenRecord(
      { accessToken: 'at-2', expiresIn: 3600 },
      { refreshToken: 'rt-existing' },
      () => '2026-10-26T00:00:00.000Z',
    );
    expect(record.refreshToken).toBe('rt-existing');
    expect(record.accessToken).toBe('at-2');
    expect(record.accessTokenExpiresAt).toBe('2026-10-26T01:00:00.000Z');
  });

  it('toTokenRecord fails closed when no refresh token exists anywhere', () => {
    expect(() => toTokenRecord({ accessToken: 'at-2' }, null)).toThrowError(/no refresh_token/);
  });
});
