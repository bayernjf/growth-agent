// `npm run gsc:auth` (review F-08): the online GSC OAuth installed-app
// handshake previously had NO entry point — operators were told to improvise
// a one-off script, and the returned `state` was never compared against the
// one sent. This CLI closes both halves:
//
//   1. start a loopback receiver on 127.0.0.1:<ephemeral>
//   2. print the consent URL (with a fresh random state)
//   3. wait for the redirect and REQUIRE the state to match
//   4. exchange the code and seal the refresh token via GscTokenStore
//
// The token itself is never printed. Scope stays webmasters.readonly.

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.js';
import {
  buildConsentUrl,
  exchangeCodeForToken,
  startLocalCodeReceiver,
  toTokenRecord,
} from '../connector/gsc/oauth.js';
import { decodeMasterKey } from '../connector/gsc/crypto.js';
import { GscTokenStore } from '../connector/gsc/token-store.js';
import { GrowthAgentErrors } from '../errors.js';

export async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.gscClientId || !config.gscClientSecret) {
    throw GrowthAgentErrors.gscCredentialMissing(
      'GA_GSC_CLIENT_ID / GA_GSC_CLIENT_SECRET required for the OAuth handshake',
    );
  }
  const masterKey = decodeMasterKey(config.growthMasterKey);
  const store = new GscTokenStore({ dir: config.gscTokenDir, masterKey });

  const state = randomBytes(16).toString('hex');
  const receiver = await startLocalCodeReceiver();
  try {
    const redirectUri = `http://127.0.0.1:${receiver.port}/`;
    const consentUrl = buildConsentUrl({
      clientId: config.gscClientId,
      redirectUri,
      state,
    });
    console.log('Open this URL in a browser on THIS machine to authorize read-only GSC access:');
    console.log(`\n  ${consentUrl}\n`);
    console.log(`Waiting for the redirect on ${redirectUri} ...`);

    const { code } = await receiver.waitForCode(state);
    const tokenSet = await exchangeCodeForToken(
      { clientId: config.gscClientId, clientSecret: config.gscClientSecret },
      { code, redirectUri },
    );
    store.save(toTokenRecord(tokenSet, null));
    console.log(`GSC refresh token sealed: ${store.describe()}`);
  } finally {
    await receiver.close();
  }
}

/** Exported for tests; auto-runs only when executed as a script. */
export { main as runGscAuth };

const invokedAsScript =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch((err: unknown) => {
    console.error(`gsc:auth: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
