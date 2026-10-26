// Encrypted GSC refresh-token file store (design §8).
//
// Decision rationale (committed with 003): the §8 table says refresh tokens
// land on the "gsc_tokens 卷" (docker volume), and §8 rule 4 demands the
// ciphertext volume be SEPARATE from the master-key env. A file directory
// (GA_GSC_TOKEN_DIR, default ./data/gsc-tokens) is the natural fit for a
// volume and stays dialect-independent — no sqlite/postgres migration needed,
// so the ciphertext never joins the business database that already holds
// growth_tasks / api_calls / ledgers.
//
// Write path is atomic (temp file + rename) so a crash mid-save cannot
// leave a half-written ciphertext. Decrypt failures never return null:
// missing file = first run (null), everything else = fail-closed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GrowthAgentErrors } from '../../errors.js';
import { openSealedToken, sealToken, type SealedToken } from './crypto.js';

/** Plaintext record kept inside the AES-256-GCM envelope. */
export interface GscTokenRecord {
  refreshToken: string;
  accessToken?: string | undefined;
  /** ISO expiry of the short-lived access token; null-ish = unknown. */
  accessTokenExpiresAt?: string | undefined;
}

export interface GscTokenStoreDeps {
  /** Directory holding the sealed token file (the gsc_tokens volume mount). */
  dir: string;
  /** Decoded 32-byte master key (GA_GROWTH_MASTER_KEY). */
  masterKey: Buffer;
  /** Injectable clock (tests). */
  now?: () => string;
}

const FILE_NAME = 'refresh-token.json';

export class GscTokenStore {
  private readonly dir: string;
  private readonly masterKey: Buffer;
  private readonly now: () => string;
  private readonly filePath: string;

  constructor(deps: GscTokenStoreDeps) {
    this.dir = deps.dir;
    this.masterKey = deps.masterKey;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.filePath = join(this.dir, FILE_NAME);
  }

  /** Absolute path of the sealed file (used by .gitignore / backup docs). */
  get sealedFilePath(): string {
    return this.filePath;
  }

  /** First-run state: no sealed file yet. */
  hasToken(): boolean {
    return existsSync(this.filePath);
  }

  /**
   * Read + decrypt the sealed record. Returns null only when the file does
   * not exist (pre-OAuth state). A present-but-unreadable file is a
   * fail-closed CREDENTIAL_STORAGE_INVALID — never downgraded to "re-auth".
   */
  load(): GscTokenRecord | null {
    if (!existsSync(this.filePath)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      throw GrowthAgentErrors.credentialStorageInvalid(
        `cannot read sealed gsc token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let sealed: unknown;
    try {
      sealed = JSON.parse(raw) as unknown;
    } catch {
      throw GrowthAgentErrors.credentialStorageInvalid('sealed gsc token file is not JSON');
    }
    const plaintext = openSealedToken(sealed, this.masterKey);
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(plaintext) as Record<string, unknown>;
    } catch {
      throw GrowthAgentErrors.credentialStorageInvalid('unsealed gsc token payload is not JSON');
    }
    if (typeof record.refreshToken !== 'string' || record.refreshToken === '') {
      throw GrowthAgentErrors.credentialStorageInvalid('unsealed record missing refreshToken');
    }
    return {
      refreshToken: record.refreshToken,
      ...(typeof record.accessToken === 'string' ? { accessToken: record.accessToken } : {}),
      ...(typeof record.accessTokenExpiresAt === 'string'
        ? { accessTokenExpiresAt: record.accessTokenExpiresAt }
        : {}),
    };
  }

  /**
   * Seal + persist. Called both after the installed-app handshake and after
   * every token refresh (Google may rotate refresh tokens — the new record
   * re-seals and overwrites the old one).
   */
  save(record: GscTokenRecord): void {
    if (record.refreshToken === '') {
      throw GrowthAgentErrors.validation('refusing to save an empty refresh token');
    }
    mkdirSync(this.dir, { recursive: true });
    const plaintext = JSON.stringify({
      refreshToken: record.refreshToken,
      ...(record.accessToken !== undefined ? { accessToken: record.accessToken } : {}),
      ...(record.accessTokenExpiresAt !== undefined
        ? { accessTokenExpiresAt: record.accessTokenExpiresAt }
        : {}),
    });
    const sealed: SealedToken = sealToken(plaintext, this.masterKey, this.now());
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(sealed, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  /** Short human descriptor for boot logs; NEVER the token itself (§8). */
  describe(): string {
    return this.hasToken() ? `sealed at ${this.filePath}` : 'no sealed token yet';
  }
}
