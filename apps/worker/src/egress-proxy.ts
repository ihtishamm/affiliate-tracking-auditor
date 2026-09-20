import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Logger, SsrfOptions } from '@auditor/shared';
import { checkTargetUrl } from '@auditor/shared/ssrf';

// The egress proxy: the one door through which the audited browser reaches the network.
//
// Why it exists: Chromium follows redirects internally and Playwright's request routing never
// sees the redirected request (verified on this project: a 302 to the store was followed even
// after route.abort()). So "re-check after every redirect hop" (§9) cannot be enforced from
// inside the browser. Launching Chromium with this proxy makes every connection — the first
// navigation, each redirect target, every pixel, iframe and script — arrive here first as a
// CONNECT (https) or an absolute-form request (http). The proxy resolves the hostname itself,
// runs the same verdict as the submission endpoint, and opens the upstream connection to the
// address it checked. A name that resolves to 10.0.0.1 gets a 403 and never a packet; a name
// that changes its answer between our lookup and the connection (DNS rebinding) cannot, since
// we connect to the address we looked up.
//
// It does not look inside TLS: a CONNECT tunnel is bytes in, bytes out. Filtering is by
// destination, which is all §9 asks for.

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, for chromium.launch({ proxy }). */
  server: string;
  /** Why the most recent connection to `host` was refused, if it was. Lets a trace name the reason. */
  reasonFor(host: string): string | undefined;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  ssrf: SsrfOptions;
  log: Logger;
}

export async function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const refused = new Map<string, string>();
  const server: Server = createServer();

  // https: CONNECT host:port — tunnel to the vetted address, or 403.
  server.on('connect', (req, socket: Duplex, head: Buffer) => {
    const target = parseHostPort(req.url ?? '', 443);
    socket.on('error', () => undefined);
    if (!target) return void socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    void vet('https', target.host, target.port, opts).then((verdict) => {
      if (!verdict.ok) {
        refused.set(target.host, verdict.reason);
        opts.log.warn('egress refused', {
          host: target.host,
          port: target.port,
          reason: verdict.reason,
        });
        return void socket.end(
          `HTTP/1.1 403 Forbidden\r\nX-Auditor-Blocked: ${verdict.reason}\r\nContent-Length: 0\r\n\r\n`,
        );
      }
      const upstream = connect({ host: verdict.address, port: target.port }, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
    });
  });

  // http: absolute-form request line — forward to the vetted address, or 403.
  server.on('request', (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      return void res.writeHead(400).end();
    }
    const port = Number(url.port || 80);
    void vet('http', url.hostname, port, opts).then((verdict) => {
      if (!verdict.ok) {
        refused.set(url.hostname, verdict.reason);
        opts.log.warn('egress refused', { host: url.hostname, port, reason: verdict.reason });
        res.writeHead(403, { 'x-auditor-blocked': verdict.reason, 'content-type': 'text/plain' });
        return void res.end(`blocked by the auditor: ${verdict.reason}`);
      }
      const headers: Record<string, string | string[] | undefined> = {
        ...req.headers,
        host: url.host,
      };
      delete headers['proxy-connection'];
      const upstream = httpRequest(
        {
          host: verdict.address,
          port,
          method: req.method,
          path: url.pathname + url.search,
          headers,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  opts.log.info('egress proxy listening', { port, allow_private: opts.ssrf.allowPrivate === true });

  return {
    server: `http://127.0.0.1:${port}`,
    reasonFor: (host) => refused.get(host.toLowerCase()),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type Vet = { ok: true; address: string } | { ok: false; reason: string };

/** The submission endpoint's verdict, applied to a connection. Hostnames are normalised the way Chromium sends them. */
async function vet(
  scheme: 'http' | 'https',
  host: string,
  port: number,
  opts: EgressProxyOptions,
): Promise<Vet> {
  const hostname = host.replace(/\.$/, '').toLowerCase();
  const literal = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  const verdict = await checkTargetUrl(`${scheme}://${literal}:${port}/`, opts.ssrf);
  if (!verdict.allowed) return { ok: false, reason: verdict.reason };
  // Prefer IPv4: the worker's container (Railway) has no IPv6 egress by default, and many
  // public hosts list AAAA records first. Every address was vetted, so any is safe to pick.
  const address = verdict.addresses.find((a) => isIP(a) === 4) ?? verdict.addresses[0];
  if (!address) return { ok: false, reason: 'no address' };
  return { ok: true, address };
}

function parseHostPort(input: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(input);
  if (!m?.[1]) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
}
