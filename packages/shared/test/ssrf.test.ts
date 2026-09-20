import { describe, expect, it } from 'vitest';
import { checkTargetUrl, isBlockedAddress } from '../src/ssrf.ts';

// A resolver the tests control: the guard must be judged on what a name resolves to, and
// real DNS is neither deterministic nor something CI should depend on.
function resolver(table: Record<string, string[]>) {
  return async (hostname: string): Promise<string[]> => {
    const addrs = table[hostname];
    if (!addrs) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return addrs;
  };
}

describe('isBlockedAddress', () => {
  it('blocks every §9 range and the usual extras', () => {
    for (const a of [
      '10.0.0.1',
      '172.16.5.5',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '127.9.9.9',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fc00::1',
      'fd12::1',
      'fe80::1',
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const a of ['8.8.8.8', '76.76.21.21', '172.32.0.1', '2606:4700::1111']) {
      expect(isBlockedAddress(a), a).toBe(false);
    }
  });

  it('sees through IPv4-mapped IPv6', () => {
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedAddress('::FFFF:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('refuses anything that is not an IP', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });
});

describe('checkTargetUrl', () => {
  const resolve = resolver({
    'shop.example': ['203.0.113.10'],
    'dual.example': ['203.0.113.10', '10.0.0.7'],
    'v6.example': ['2606:4700::1111'],
    'metadata.attacker': ['169.254.169.254'],
    localhost: ['127.0.0.1'],
  });

  it('allows an ordinary public https URL and reports what it resolved to', async () => {
    const v = await checkTargetUrl('https://shop.example/landing?click_id=x', { resolve });
    expect(v).toMatchObject({ allowed: true, addresses: ['203.0.113.10'] });
  });

  it('refuses non-http schemes, credentials and non-standard ports', async () => {
    expect(await checkTargetUrl('ftp://shop.example/', { resolve })).toMatchObject({
      allowed: false,
      reason: /scheme ftp/,
    });
    expect(await checkTargetUrl('file:///etc/passwd', { resolve })).toMatchObject({
      allowed: false,
    });
    expect(await checkTargetUrl('https://user:pw@shop.example/', { resolve })).toMatchObject({
      allowed: false,
      reason: /credentials/,
    });
    expect(await checkTargetUrl('http://shop.example:6379/', { resolve })).toMatchObject({
      allowed: false,
      reason: /port 6379/,
    });
    expect(await checkTargetUrl('not a url', { resolve })).toMatchObject({
      allowed: false,
      reason: /not a valid/,
    });
  });

  it('refuses local names and private IP literals before touching DNS', async () => {
    const neverResolve = async (): Promise<string[]> => {
      throw new Error('DNS must not be called');
    };
    for (const url of [
      'http://localhost/',
      'http://foo.localhost/',
      'http://redis.railway.internal/',
      'http://printer.local/',
      'http://10.0.0.1/',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(await checkTargetUrl(url, { resolve: neverResolve }), url).toMatchObject({
        allowed: false,
      });
    }
  });

  it('refuses a name when ANY resolved address is private', async () => {
    expect(await checkTargetUrl('https://dual.example/', { resolve })).toMatchObject({
      allowed: false,
      reason: /resolves to private address 10\.0\.0\.7/,
    });
    expect(await checkTargetUrl('https://metadata.attacker/', { resolve })).toMatchObject({
      allowed: false,
    });
  });

  it('IPv6-only public hosts are fine', async () => {
    expect(await checkTargetUrl('https://v6.example/', { resolve })).toMatchObject({
      allowed: true,
    });
  });

  it('a name that does not resolve is a verdict, not an exception', async () => {
    expect(await checkTargetUrl('https://nope.example/', { resolve })).toMatchObject({
      allowed: false,
      reason: /ENOTFOUND/,
    });
  });

  it('allowPrivate (development only) admits localhost on any port, but still not ftp://', async () => {
    expect(
      await checkTargetUrl('http://localhost:3001/advertorial', { resolve, allowPrivate: true }),
    ).toMatchObject({ allowed: true });
    expect(
      await checkTargetUrl('http://10.0.0.1:8080/', { resolve, allowPrivate: true }),
    ).toMatchObject({ allowed: true });
    expect(await checkTargetUrl('ftp://localhost/', { resolve, allowPrivate: true })).toMatchObject(
      { allowed: false },
    );
  });
});
