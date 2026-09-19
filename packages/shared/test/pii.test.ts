import { describe, expect, it } from 'vitest';
import {
  hashEmail,
  hashPhone,
  looksLikeSha256,
  normaliseEmail,
  normalisePhone,
  sha256Hex,
} from '../src/pii.ts';

describe('normalisation before hashing', () => {
  it('email: trims and lower-cases, so the hash matches what Meta computes', () => {
    expect(normaliseEmail('  Buyer@Example.COM ')).toBe('buyer@example.com');
    expect(hashEmail('  Buyer@Example.COM ')).toBe(hashEmail('buyer@example.com'));
    expect(hashEmail('Buyer@Example.com')).not.toBe(sha256Hex('Buyer@Example.com'));
  });

  it('phone: digits only, leading zeros dropped, country code kept', () => {
    expect(normalisePhone('+1 (555) 010-0000')).toBe('15550100000');
    expect(normalisePhone('0044 20 7946 0958')).toBe('442079460958');
    expect(hashPhone('+1 555 010 0000')).toBe(hashPhone('15550100000'));
  });

  it('empty or missing input hashes to nothing rather than to sha256("")', () => {
    expect(hashEmail(null)).toBeNull();
    expect(hashEmail('   ')).toBeNull();
    expect(hashPhone(undefined)).toBeNull();
    expect(hashPhone('+-()')).toBeNull();
  });

  it('produces a 64-hex-character digest that looksLikeSha256 recognises', () => {
    const digest = hashEmail('buyer@example.com');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(looksLikeSha256(digest as string)).toBe(true);
    expect(looksLikeSha256('buyer@example.com')).toBe(false);
    expect(looksLikeSha256('deadbeef')).toBe(false);
  });

  it('matches an independently computed SHA-256 (coreutils sha256sum)', () => {
    // A regression in the hashing itself, not just the normalisation, would be caught here.
    expect(sha256Hex('buyer@example.com')).toBe(
      '6a6c26195c3682faa816966af789717c3bfa834eee6c599d667d2b3429c27cfd',
    );
  });
});
