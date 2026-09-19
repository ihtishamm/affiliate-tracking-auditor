import { describe, expect, it } from 'vitest';
import { signBase64, signHex, verifyBase64, verifyHex } from '../src/hmac.ts';

// Deliberately low-entropy: a value that looks like a real key here would trip the secret scanner.
const secret = 'unit-test-signing-key-not-a-real-secret';
const body = '{"postback_id":"pb-1","click_id":"abc","amount":10.5}';

describe('verifyHex', () => {
  it('accepts the signature of the exact bytes', () => {
    expect(verifyHex(secret, body, signHex(secret, body))).toBe(true);
  });

  it('accepts upper-case hex (Buffer decoding is case-insensitive)', () => {
    expect(verifyHex(secret, body, signHex(secret, body).toUpperCase())).toBe(true);
  });

  it('rejects a body changed by one byte', () => {
    const signature = signHex(secret, body);
    expect(verifyHex(secret, body.replace('10.5', '10.6'), signature)).toBe(false);
  });

  it('rejects a semantically identical body with different bytes', () => {
    // Same JSON value, different serialisation: the signature must not survive re-serialising.
    const signature = signHex(secret, body);
    const reformatted = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyHex(secret, reformatted, signature)).toBe(false);
  });

  it('rejects a signature changed by one hex digit', () => {
    const signature = signHex(secret, body);
    const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
    expect(verifyHex(secret, body, flipped)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyHex(secret, body, signHex('other-secret', body))).toBe(false);
  });

  it('rejects missing, empty, short, long and non-hex signatures without throwing', () => {
    expect(verifyHex(secret, body, null)).toBe(false);
    expect(verifyHex(secret, body, undefined)).toBe(false);
    expect(verifyHex(secret, body, '')).toBe(false);
    expect(verifyHex(secret, body, 'abcd')).toBe(false);
    expect(verifyHex(secret, body, signHex(secret, body) + '00')).toBe(false);
    expect(verifyHex(secret, body, 'zz'.repeat(32))).toBe(false);
  });
});

describe('verifyBase64 (Shopify format)', () => {
  it('accepts a base64 signature of the raw body', () => {
    expect(verifyBase64(secret, body, signBase64(secret, body))).toBe(true);
  });

  it('rejects a tampered body and a tampered signature', () => {
    const signature = signBase64(secret, body);
    expect(verifyBase64(secret, body + ' ', signature)).toBe(false);
    expect(verifyBase64(secret, body, 'A' + signature.slice(1))).toBe(false);
  });

  it('works on bytes as well as strings (multi-byte characters intact)', () => {
    const bytes = new TextEncoder().encode('{"name":"Zoë"}');
    expect(verifyBase64(secret, bytes, signBase64(secret, bytes))).toBe(true);
    expect(verifyBase64(secret, '{"name":"Zoe"}', signBase64(secret, bytes))).toBe(false);
  });
});
