import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createOpaqueToken,
  createStoredToken,
  hashToken,
} from '../../src/domain/tokens.js';

describe('opaque tokens', () => {
  it('creates a base64url token from exactly 32 random bytes', () => {
    const token = createOpaqueToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(64);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('hashes the raw token before database storage', () => {
    expect(hashToken('known-token')).toBe(
      createHash('sha256').update('known-token').digest('hex'),
    );

    const token = createStoredToken();
    expect(token.tokenHash).toBe(hashToken(token.token));
  });
});
