import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeMasterKey } from '../../src/connector/gsc/crypto.js';
import { GscTokenStore } from '../../src/connector/gsc/token-store.js';
import { GrowthAgentError } from '../../src/errors.js';

let dir: string;
const key = () => decodeMasterKey(randomBytes(32).toString('hex'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gsc-tokens-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('GscTokenStore (§8 encrypted file volume)', () => {
  it('returns null on first run (no sealed file) and round-trips a saved record', () => {
    const store = new GscTokenStore({ dir, masterKey: key() });
    expect(store.hasToken()).toBe(false);
    expect(store.load()).toBeNull();

    store.save({ refreshToken: 'rt-first', accessToken: 'at-1', accessTokenExpiresAt: '2026-10-26T01:00:00.000Z' });
    expect(store.hasToken()).toBe(true);
    expect(store.load()).toEqual({
      refreshToken: 'rt-first',
      accessToken: 'at-1',
      accessTokenExpiresAt: '2026-10-26T01:00:00.000Z',
    });
  });

  it('sealed file on disk is ciphertext, never the raw refresh token', () => {
    const store = new GscTokenStore({ dir, masterKey: key() });
    store.save({ refreshToken: 'super-secret-refresh-token-xyz' });
    const onDisk = readFileSync(store.sealedFilePath, 'utf8');
    expect(onDisk).not.toContain('super-secret-refresh-token-xyz');
    expect(JSON.parse(onDisk)).toMatchObject({ v: 1, iv: expect.any(String), tag: expect.any(String), ct: expect.any(String) });
  });

  it('re-seals a rotated refresh token on top of the old file', () => {
    const store = new GscTokenStore({ dir, masterKey: key() });
    store.save({ refreshToken: 'rt-old' });
    store.save({ refreshToken: 'rt-rotated', accessToken: 'at-2' });
    expect(store.load()).toEqual({ refreshToken: 'rt-rotated', accessToken: 'at-2' });
  });

  it('fails closed (never falls back to re-auth) when the file is tampered', () => {
    const store = new GscTokenStore({ dir, masterKey: key() });
    store.save({ refreshToken: 'rt-first' });
    writeFileSync(store.sealedFilePath, '{"v":1,"iv":"AAAA","tag":"AAAA","ct":"AAAA"}', 'utf8');
    try {
      store.load();
      throw new Error('expected fail-closed');
    } catch (err) {
      expect(err).toBeInstanceOf(GrowthAgentError);
      expect((err as GrowthAgentError).code).toBe('CREDENTIAL_STORAGE_INVALID');
    }
  });

  it('fails closed when the sealed file was written under a DIFFERENT master key', () => {
    const storeA = new GscTokenStore({ dir, masterKey: key() });
    storeA.save({ refreshToken: 'rt-from-key-a' });
    const storeB = new GscTokenStore({ dir, masterKey: key() });
    expect(() => storeB.load()).toThrowError(/unseal failed/);
  });

  it('refuses to save an empty refresh token', () => {
    const store = new GscTokenStore({ dir, masterKey: key() });
    expect(() => store.save({ refreshToken: '' })).toThrowError(/empty refresh token/);
  });
});
