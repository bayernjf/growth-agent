// Google OAuth 2.0 installed-app flow, library layer only (design §4.1, §8).
//
// SCOPE IS STRICTLY READ-ONLY: https://www.googleapis.com/auth/webmasters.readonly
// (never .readonly → write). The flow is:
//   1. buildConsentUrl() -> operator opens it in a browser on this machine;
//   2. startLocalCodeReceiver() listens on 127.0.0.1:<ephemeral port> for the
//      redirect and captures `code`;
//   3. exchangeCodeForToken() swaps the code at the token endpoint;
//   4. the resulting refresh token is sealed by GscTokenStore (crypto.ts).
//
// NOT REALLY RUN END-TO-END YET: Google endpoint URLs follow the documented
// installed-app conventions but have NOT been hit with a real client id
// (real e2e belongs to T-B4). fetchImpl is injectable so the wire shapes are
// contract-tested against a local node:http fake server.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GrowthAgentErrors } from '../../errors.js';
import type { GscTokenRecord } from './token-store.js';

export const GSC_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface OAuthTokenSet {
  accessToken: string;
  /** seconds until access_token expiry (from Google). */
  expiresIn?: number | undefined;
  /** Present only on first consent (Google does not re-issue it every refresh). */
  refreshToken?: string | undefined;
  scope?: string | undefined;
}

/** Step 1: build the consent-screen URL. */
export function buildConsentUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: GSC_READONLY_SCOPE,
    access_type: 'offline',
    prompt: 'consent', // force a fresh refresh_token even for returning consents
    state: args.state,
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Step 2: loopback redirect receiver (127.0.0.1, ephemeral port).
// ---------------------------------------------------------------------------

export interface ReceivedCode {
  code: string;
  state: string | null;
}

export interface LocalCodeReceiver {
  readonly port: number;
  /**
   * Resolves with the captured code. When `expectedState` is given, the
   * redirect's `state` must match the one sent in buildConsentUrl — a
   * mismatch rejects with VALIDATION_FAILED (F-08: OAuth baseline CSRF
   * protection; previously the returned state was never compared).
   */
  waitForCode(expectedState?: string): Promise<ReceivedCode>;
  close(): Promise<void>;
}

export async function startLocalCodeReceiver(): Promise<LocalCodeReceiver> {
  let resolve!: (value: ReceivedCode) => void;
  let reject!: (err: Error) => void;
  const received = new Promise<ReceivedCode>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  // Mark the bare promise handled as early as possible: the HTTP handler may
  // reject it before the caller attaches waitForCode()'s consumer, which Node
  // would otherwise flag as an unhandled rejection. Consumers still receive
  // the rejection through waitForCode().
  received.catch(() => {});

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const sendHtml = (status: number, heading: string, body: string): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>growth-agent</title>` +
          `<h1>${heading}</h1><p>${body}</p>`,
      );
    };
    const errorParam = url.searchParams.get('error');
    if (errorParam !== null) {
      sendHtml(400, 'Authorization denied', 'You can close this tab.');
      reject(
        GrowthAgentErrors.gscAuthRevoked(
          `google consent returned error=${errorParam}` +
            (url.searchParams.get('error_description') ?? ''),
        ),
      );
      return;
    }
    const code = url.searchParams.get('code');
    if (code === null) {
      sendHtml(400, 'Bad callback', 'Missing code. You can close this tab.');
      return;
    }
    sendHtml(
      200,
      'Authorized',
      'growth-agent received the code. You can close this tab now.',
    );
    resolve({ code, state: url.searchParams.get('state') });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    waitForCode: (expectedState?: string) => {
      const checked = received.then(value => {
        if (expectedState !== undefined && value.state !== expectedState) {
          throw GrowthAgentErrors.validation(
            'oauth callback state mismatch — refusing the code (possible CSRF or stale callback)',
          );
        }
        return value;
      });
      // Same early-handle discipline as `received` above: the HTTP handler may
      // settle before the caller attaches its consumer; consumers still get
      // the rejection through the returned promise.
      checked.catch(() => {});
      return checked;
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

// ---------------------------------------------------------------------------
// Steps 3-4: token endpoint exchange (form-encoded, per Google conventions).
// ---------------------------------------------------------------------------

export interface OAuthClientDeps {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  tokenEndpoint?: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postToken(
  deps: OAuthClientDeps,
  form: Record<string, string>,
): Promise<OAuthTokenSet> {
  const endpoint = deps.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw GrowthAgentErrors.upstreamUnavailable(
      `gsc token endpoint unreachable: ${err instanceof Error ? err.message : 'network error'}`,
    );
  }
  const text = await response.text();
  let body: GoogleTokenResponse = {};
  try {
    body = JSON.parse(text) as GoogleTokenResponse;
  } catch {
    body = {};
  }

  // `invalid_grant` = code/refresh token rejected (expired, revoked, reused).
  if (!response.ok || body.error !== undefined) {
    if (body.error === 'invalid_grant') {
      throw GrowthAgentErrors.gscAuthRevoked(
        body.error_description ?? 'google rejected the grant (invalid_grant)',
        body,
      );
    }
    if (response.status === 403) {
      throw GrowthAgentErrors.gscScopeInsufficient(
        body.error_description ?? 'google token endpoint 403',
        body,
      );
    }
    if (response.status >= 500) {
      throw GrowthAgentErrors.upstreamUnavailable(
        `gsc token endpoint returned HTTP ${response.status}`,
        body,
      );
    }
    throw GrowthAgentErrors.upstreamUnavailable(
      `gsc token endpoint returned HTTP ${response.status}: ${body.error ?? 'unknown'}`,
      body,
    );
  }

  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw GrowthAgentErrors.upstreamUnavailable('google token response missing access_token', body);
  }
  return {
    accessToken: body.access_token,
    ...(typeof body.expires_in === 'number' ? { expiresIn: body.expires_in } : {}),
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  };
}

/** First handshake: authorization code -> access + refresh token. */
export async function exchangeCodeForToken(
  deps: OAuthClientDeps,
  args: { code: string; redirectUri: string },
): Promise<OAuthTokenSet> {
  if (deps.clientId === '' || deps.clientSecret === '') {
    throw GrowthAgentErrors.gscCredentialMissing(
      'GA_GSC_CLIENT_ID / GA_GSC_CLIENT_SECRET required for the OAuth handshake',
    );
  }
  return postToken(deps, {
    code: args.code,
    client_id: deps.clientId,
    client_secret: deps.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });
}

/**
 * Refresh an access token. Google MAY rotate the refresh_token on refresh;
 * the orchestrator stores whatever comes back (the store re-seals the whole
 * record, so a rotated refresh token replaces the old one).
 */
export async function refreshAccessToken(
  deps: OAuthClientDeps,
  refreshToken: string,
): Promise<OAuthTokenSet> {
  if (deps.clientId === '' || deps.clientSecret === '') {
    throw GrowthAgentErrors.gscCredentialMissing(
      'GA_GSC_CLIENT_ID / GA_GSC_CLIENT_SECRET required to refresh GSC tokens',
    );
  }
  return postToken(deps, {
    refresh_token: refreshToken,
    client_id: deps.clientId,
    client_secret: deps.clientSecret,
    grant_type: 'refresh_token',
  });
}

/** Fold a token set into the sealed record (keeps old refresh token if Google rotated nothing). */
export function toTokenRecord(
  set: OAuthTokenSet,
  previous: GscTokenRecord | null,
  now: () => string = () => new Date().toISOString(),
): GscTokenRecord {
  const refreshToken = set.refreshToken ?? previous?.refreshToken;
  if (refreshToken === undefined) {
    throw GrowthAgentErrors.gscAuthRevoked(
      'token exchange returned no refresh_token and none was stored before',
    );
  }
  const expiresAt =
    set.expiresIn !== undefined
      ? new Date(Date.parse(now()) + set.expiresIn * 1000).toISOString()
      : previous?.accessTokenExpiresAt;
  return {
    refreshToken,
    ...(set.accessToken !== '' ? { accessToken: set.accessToken } : {}),
    ...(expiresAt !== undefined ? { accessTokenExpiresAt: expiresAt } : {}),
  };
}
