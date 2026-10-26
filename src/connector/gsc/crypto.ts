// AES-256-GCM cipher for the encrypted GSC refresh-token file (design §8).
//
// Hard rules (§8):
//   - master key comes ONLY from env (GA_GROWTH_MASTER_KEY; the §8
//     GROWTH_MASTER_KEY), never from the business database, logs or errors.
//   - ciphertext file and master key live in separate volumes (the file
//     lives under GA_GSC_TOKEN_DIR; the key never leaves the operator's env).
//   - missing master key / wrong key length / GCM auth-tag verification
//     failure / tampered bytes all fail closed with CREDENTIAL_STORAGE_INVALID.
//
// Wire format of one sealed token:
//   { v: 1, iv: base64(12B), tag: base64(16B), ct: base64(AES-256-GCM(plaintext)) }
// plaintext = JSON of the token record.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { GrowthAgentErrors } from '../../errors.js';

export const GCM_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const MASTER_KEY_BYTES = 32;
export const SEAL_FORMAT_VERSION = 1;

export interface SealedToken {
  v: number;
  iv: string;
  tag: string;
  ct: string;
  /** ISO timestamp of the last seal (refresh-token rotation re-seals). */
  updatedAt: string;
}

/**
 * Decode the operator-supplied master key into exactly 32 bytes.
 * Accepts 64-char hex OR base64 of 32 bytes. Anything else is fail-closed —
 * we never fall back to a default/dev key.
 */
export function decodeMasterKey(raw: string | undefined): Buffer {
  if (raw === undefined || raw.trim() === '') {
    throw GrowthAgentErrors.credentialStorageInvalid(
      'GA_GROWTH_MASTER_KEY is not set (design §8: AES-256 key, env-only)',
    );
  }
  const trimmed = raw.trim();
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    bytes = Buffer.from(trimmed, 'hex');
  } else {
    try {
      bytes = Buffer.from(trimmed, 'base64');
    } catch {
      throw GrowthAgentErrors.credentialStorageInvalid(
        'GA_GROWTH_MASTER_KEY must be 64 hex chars or base64 of 32 bytes',
      );
    }
  }
  if (bytes.length !== MASTER_KEY_BYTES) {
    throw GrowthAgentErrors.credentialStorageInvalid(
      `GA_GROWTH_MASTER_KEY decodes to ${bytes.length} bytes; AES-256 requires ${MASTER_KEY_BYTES}`,
    );
  }
  return bytes;
}

/** Encrypt a plaintext record; `updatedAt` defaults to now (injectable in tests). */
export function sealToken(
  plaintext: string,
  masterKey: Buffer,
  updatedAt: string = new Date().toISOString(),
): SealedToken {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw GrowthAgentErrors.credentialStorageInvalid(
      `master key length ${masterKey.length} != ${MASTER_KEY_BYTES}`,
    );
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: SEAL_FORMAT_VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
    updatedAt,
  };
}

/**
 * Decrypt a sealed token. Any structural problem, wrong key or tampered
 * byte makes GCM auth-tag verification fail — surface all of it as one
 * fail-closed error (no oracle distinguishing "bad key" from "corrupt file").
 */
export function openSealedToken(sealed: unknown, masterKey: Buffer): string {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw GrowthAgentErrors.credentialStorageInvalid(
      `master key length ${masterKey.length} != ${MASTER_KEY_BYTES}`,
    );
  }
  const s = sealed as Partial<SealedToken> | null;
  if (s === null || typeof s !== 'object') {
    throw GrowthAgentErrors.credentialStorageInvalid('gsc token file is not a sealed record');
  }
  if (s.v !== SEAL_FORMAT_VERSION) {
    throw GrowthAgentErrors.credentialStorageInvalid(`unsupported seal version: ${String(s.v)}`);
  }
  const iv = decodeB64(s.iv, GCM_IV_BYTES, 'iv');
  const tag = decodeB64(s.tag, GCM_TAG_BYTES, 'tag');
  const ct = decodeB64(s.ct, undefined, 'ct');

  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // Wrong master key OR tampered iv/tag/ct: GCM auth fails identically.
    throw GrowthAgentErrors.credentialStorageInvalid(
      'gsc token unseal failed (wrong GA_GROWTH_MASTER_KEY or tampered ciphertext)',
    );
  }
}

function decodeB64(value: unknown, expectedBytes: number | undefined, field: string): Buffer {
  if (typeof value !== 'string' || value === '') {
    throw GrowthAgentErrors.credentialStorageInvalid(`gsc token seal missing field: ${field}`);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    throw GrowthAgentErrors.credentialStorageInvalid(`gsc token seal field not base64: ${field}`);
  }
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw GrowthAgentErrors.credentialStorageInvalid(
      `gsc token seal field ${field} length ${bytes.length} != ${expectedBytes}`,
    );
  }
  return bytes;
}

/**
 * Log-safe mask: at most the first 4 chars, everything else hidden (§8:
 * logs/error bodies may never echo a full token).
 */
export function maskSecret(secret: string): string {
  if (secret.length <= 4) return '****';
  return `${secret.slice(0, 4)}…(${secret.length} chars)`;
}
