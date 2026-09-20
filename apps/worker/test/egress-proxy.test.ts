import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@auditor/shared';
import { startEgressProxy, type EgressProxy } from '../src/egress-proxy.ts';

// The proxy is the SSRF enforcement point, so it is tested at the level the browser uses it:
// raw CONNECT and absolute-form HTTP over a socket, with a resolver the test controls.

const log = createLogger({ service: 'test', level: 'error', write: () => {} });
let origin: Server;
let originPort = 0;
let proxy: EgressProxy;

beforeAll(async () => {
  origin = createServer((req, res) => res.end(`hello from origin ${req.headers.host} ${req.url}`));
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  originPort = (origin.address() as { port: number }).port;
  proxy = await startEgressProxy({
    log,
    ssrf: {
      allowPrivate: true, // the origin above is 127.0.0.1; blocking is exercised through the resolver instead
      resolve: async (host) => {
        if (host === 'origin.test') return ['127.0.0.1'];
        if (host === 'metadata.test') return ['169.254.169.254'];
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    },
  });
});
afterAll(async () => {
  await proxy.close();
  origin.close();
});

function proxyPort(): number {
  return Number(new URL(proxy.server).port);
}

function rawConnect(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(proxyPort(), '127.0.0.1', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let data = '';
    sock.on('data', (c) => {
      data += c.toString();
      if (data.includes('\r\n\r\n')) {
        sock.destroy();
        resolve(data);
      }
    });
    sock.on('error', reject);
  });
}

function viaProxy(url: string): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: proxyPort(),
        method: 'GET',
        path: url,
        headers: { host: new URL(url).host },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('egress proxy', () => {
  it('forwards plain HTTP to the address it resolved, with the original Host header', async () => {
    const res = await viaProxy(`http://origin.test:${originPort}/landing?click_id=x`);
    expect(res.status).toBe(200);
    expect(res.body).toBe(`hello from origin origin.test:${originPort} /landing?click_id=x`);
  });

  it('refuses a name that resolves into a blocked range, with the reason in a header', async () => {
    const proxyAllowingOnlyPublic = await startEgressProxy({
      log,
      ssrf: { resolve: async () => ['169.254.169.254'] },
    });
    try {
      const port = Number(new URL(proxyAllowingOnlyPublic.server).port);
      const res = await new Promise<{ status: number; blocked: string | undefined }>(
        (resolve, reject) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port,
              path: 'http://metadata.test/latest/meta-data/',
              headers: { host: 'metadata.test' },
            },
            (r) => {
              r.resume();
              resolve({
                status: r.statusCode ?? 0,
                blocked: r.headers['x-auditor-blocked'] as string | undefined,
              });
            },
          );
          req.on('error', reject);
          req.end();
        },
      );
      expect(res.status).toBe(403);
      expect(res.blocked).toMatch(/169\.254\.169\.254/);
      expect(proxyAllowingOnlyPublic.reasonFor('metadata.test')).toMatch(/private/);
    } finally {
      await proxyAllowingOnlyPublic.close();
    }
  });

  it('refuses a CONNECT tunnel the same way (this is what a redirect to https://10.0.0.1 becomes)', async () => {
    const strict = await startEgressProxy({ log, ssrf: { resolve: async () => ['10.0.0.1'] } });
    try {
      const port = Number(new URL(strict.server).port);
      const reply = await new Promise<string>((resolve, reject) => {
        const sock = connect(port, '127.0.0.1', () =>
          sock.write('CONNECT internal.test:443 HTTP/1.1\r\nHost: internal.test:443\r\n\r\n'),
        );
        let data = '';
        sock.on('data', (c) => {
          data += c.toString();
          if (data.includes('\r\n\r\n')) {
            sock.destroy();
            resolve(data);
          }
        });
        sock.on('error', reject);
      });
      expect(reply).toMatch(/^HTTP\/1\.1 403/);
      expect(reply).toMatch(/X-Auditor-Blocked: .*10\.0\.0\.1/);
    } finally {
      await strict.close();
    }
  });

  it('prefers an IPv4 address when the name also has IPv6 (containers without v6 egress)', async () => {
    const dual = await startEgressProxy({
      log,
      ssrf: { allowPrivate: true, resolve: async () => ['::1', '127.0.0.1'] },
    });
    try {
      const port = Number(new URL(dual.server).port);
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: `http://dual.test:${originPort}/v4`,
            headers: { host: `dual.test:${originPort}` },
          },
          (r) => {
            let body = '';
            r.on('data', (c) => (body += c.toString()));
            r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(200); // the origin listens on 127.0.0.1 only; ::1 would have failed
      expect(res.body).toContain('/v4');
    } finally {
      await dual.close();
    }
  });

  it('CONNECT to a resolvable host is established', async () => {
    const reply = await rawConnect(`origin.test:${originPort}`);
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
  });

  it('an unresolvable name is a 403, not a hang', async () => {
    const res = await viaProxy('http://nowhere.test/');
    expect(res.status).toBe(403);
    expect(res.headers['x-auditor-blocked']).toMatch(/ENOTFOUND/);
  });
});
