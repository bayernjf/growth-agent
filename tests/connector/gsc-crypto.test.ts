import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeMasterKey,
  maskSecret,
  openSealedToken,
  sealToken,
} from '../../src/connector/gsc/crypto.js';
import { GrowthAgentError } from '../../src/errors.js';

function hexKey(): Buffer {
  return randomBytes(32);
}

describe('gsc AES-256-GCM token cipher (§8)', () => {
  it('round-trips plaintext through seal/open', () => {
    const key = hexKey();
    const sealed = sealToken(JSON.stringify({ refreshToken: 'rt_real_value' }), key, '2026-10-26T00:00:00.000Z');
    expect(sealed.v).toBe(1);
    const plaintext = openSealedToken(sealed, key);
    expect(JSON.parse(plaintext)).toEqual({ refreshToken: 'rt_real_value' });
  });

  it('uses fresh random iv per seal (same plaintext -> different ciphertext)', () => {
    const key = hexKey();
    const a = sealToken('same-plaintext', key);
    const b = sealToken('same-plaintext', key);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ct).not.toEqual(b.ct);
  });

  it('fails closed when the master key is missing', () => {
    expect(() => decodeMasterKey(undefined)).toThrowError(/GA_GROWTH_MASTER_KEY/);
    expect(() => decodeMasterKey('')).toThrowError(/GA_GROWTH_MASTER_KEY/);
  });

  it('decodes 64-hex and base64 keys and rejects wrong lengths', () => {
    const key = hexKey();
    expect(decodeMasterKey(key.toString('hex')).equals(key)).toBe(true);
    expect(decodeMasterKey(key.toString('base64')).equals(key)).toBe(true);
    // 32 non-hex chars take the base64 path -> 24 decoded bytes.
    expect(() => decodeMasterKey('00'.repeat(16))).toThrowError(/decodes to 24 bytes/);
    expect(() => decodeMasterKey('not-a-key')).toThrowError(/AES-256 requires 32/);
  });

  it('rejects a wrong master key with a single opaque error (no oracle)', () => {
    const sealed = sealToken('secret-token-value', hexKey());
    expect(() => openSealedToken(sealed, hexKey())).toThrowError(/unseal failed/);
  });

  it('fails closed when the ciphertext is tampered with', () => {
    const key = hexKey();
    const sealed = sealToken('secret-token-value', key) as { ct: string; iv: string; tag: string };
    const tamperedCt = { ...sealed, ct: Buffer.from('tampered-bytes').toString('base64') };
    expect(() => openSealedToken(tamperedCt, key)).toThrowError(/unseal failed/);
    const tamperedIv = { ...sealed, iv: Buffer.from('0'.repeat(12)).toString('base64') };
    expect(() => openSealedToken(tamperedIv, key)).toThrowError(/unseal failed/);
    const tamperedTag = { ...sealed, tag: Buffer.from('1'.repeat(16)).toString('base64') };
    expect(() => openSealedToken(tamperedTag, key)).toThrowError(/unseal failed/);
  });

  it('rejects structurally invalid seal records (missing fields / version)', () => {
    const key = hexKey();
    expect(() => openSealedToken(null, key)).toThrowError(/sealed record/);
    expect(() => openSealedToken({}, key)).toThrowError(/version/);
    expect(() =>
      openSealedToken({ v: 1, iv: 'nope' }, key),
    ).toThrowError(/field iv/);
  });

  it('emits CREDENTIAL_STORAGE_INVALID code for every fail-closed path', () => {
    try {
      openSealedToken(sealToken('x', hexKey()), hexKey());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GrowthAgentError);
      expect((err as GrowthAgentError).code).toBe('CREDENTIAL_STORAGE_INVALID');
      expect((err as GrowthAgentError).status).toBe(500);
    }
  });

  it('masks secrets to at most the first 4 chars (§8 log discipline)', () => {
    expect(maskSecret('abcdefgh1234')).toContain('abcd');
    expect(maskSecret('abcdefgh1234')).not.toContain('efgh1234');
    expect(maskSecret('ab')).toBe('****');
  });
});
