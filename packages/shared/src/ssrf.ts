import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

// A public tool that fetches whatever URL a stranger types is, by default, a proxy into the
// network it runs in: http://169.254.169.254/ is the cloud metadata service that hands out
// credentials, http://redis.railway.internal:6379/ is our own queue, http://localhost:8080/ is
// whatever else is listening on the box. PROJECT_CONTEXT §9 lists the ranges to refuse. The
// guard has three layers, because each catches a case the previous one cannot:
//
//   1. Scheme and port. Only http/https, and (outside local development) only their default
//      ports: a funnel on :6379 or :5432 is not a funnel, it is a probe.
//   2. Literal hostnames. `localhost`, `*.localhost`, `*.internal`, `*.local` and any IP literal
//      in a blocked range are refused before any DNS call — a resolver can be tricked, a
//      string comparison cannot.
//   3. DNS resolution. The name is resolved and EVERY returned address is checked. A hostile
//      zone can answer with a public address and a private one; Chromium picks whichever it
//      likes, so one bad address fails the whole name.
//
// The verdict is applied in three places: at submission (a fast 4xx for the user), in the
// worker's route handler for each navigation Chromium asks to make, and — the one that
// actually holds — in the worker's egress proxy (apps/worker/src/egress-proxy.ts), which
// every connection passes through, redirect targets included (§9: "re-check after every
// redirect hop"; Chromium follows redirects internally, so no browser-side hook sees them).
// The proxy also connects to the address it vetted, which closes the DNS-rebinding window
// (a name resolving public for our lookup and private a moment later) for that connection.

/** Every range from §9 plus the ones an attacker reaches for next. */
const BLOCKED_RANGES: ReadonlyArray<readonly [string, number, 'ipv4' | 'ipv6']> = [
  ['0.0.0.0', 8, 'ipv4'], // "this network"; connects to localhost on Linux
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'], // carrier-grade NAT; Railway/Tailscale-style private meshes
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], // link-local, incl. cloud metadata at 169.254.169.254
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], // multicast
  ['240.0.0.0', 4, 'ipv4'], // reserved + broadcast
  ['::', 128, 'ipv6'], // unspecified
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'], // unique local
  ['fe80::', 10, 'ipv6'], // link-local
];

const blockList = new BlockList();
for (const [addr, prefix, family] of BLOCKED_RANGES) blockList.addSubnet(addr, prefix, family);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.internal', '.local', '.home.arpa'];
const ALLOWED_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

export type SsrfVerdict =
  { allowed: true; url: URL; addresses: string[] } | { allowed: false; reason: string };

export interface SsrfOptions {
  /** Development only: lets http://localhost:3001 through. The env schema refuses it in production. */
  allowPrivate?: boolean;
  /** Injected in tests; defaults to the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/** True when `address` (v4, v6, or v4-mapped v6 like ::ffff:10.0.0.1) is in a blocked range. */
export function isBlockedAddress(address: string): boolean {
  // Chromium treats ::ffff:a.b.c.d as the IPv4 address it wraps; so must we, or 10/8 would
  // be reachable by spelling it in IPv6.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const candidate = mapped?.[1] ?? address;
  const family = isIP(candidate);
  if (family === 4) return blockList.check(candidate, 'ipv4');
  if (family === 6) return blockList.check(candidate, 'ipv6');
  return true; // not an IP at all: refuse rather than guess
}

/**
 * Decides whether the runner may fetch `input`. Never throws for bad input; a URL the user
 * typed wrong is a verdict, not an exception.
 */
export async function checkTargetUrl(input: string, opts: SsrfOptions = {}): Promise<SsrfVerdict> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { allowed: false, reason: 'not a valid absolute URL' };
  }

  // Layer 1 — scheme and port.
  if (!(url.protocol in ALLOWED_PORTS)) {
    return {
      allowed: false,
      reason: `scheme ${url.protocol.replace(':', '')} is not http or https`,
    };
  }
  if (url.username || url.password) {
    return { allowed: false, reason: 'credentials in the URL are not allowed' };
  }
  if (!opts.allowPrivate && url.port && url.port !== ALLOWED_PORTS[url.protocol]) {
    return { allowed: false, reason: `non-standard port ${url.port}` };
  }

  // Layer 2 — the hostname as written.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    if (!opts.allowPrivate) return { allowed: false, reason: `hostname ${hostname} is local` };
  }
  if (isIP(hostname)) {
    if (!opts.allowPrivate && isBlockedAddress(hostname)) {
      return { allowed: false, reason: `address ${hostname} is in a private or reserved range` };
    }
    return { allowed: true, url, addresses: [hostname] };
  }

  // Layer 3 — what the name resolves to, all of it.
  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? systemResolve)(hostname);
  } catch (err) {
    return { allowed: false, reason: `hostname ${hostname} did not resolve (${errorCode(err)})` };
  }
  if (addresses.length === 0)
    return { allowed: false, reason: `hostname ${hostname} has no addresses` };
  if (!opts.allowPrivate) {
    const bad = addresses.find(isBlockedAddress);
    if (bad) {
      return { allowed: false, reason: `hostname ${hostname} resolves to private address ${bad}` };
    }
  }
  return { allowed: true, url, addresses };
}

async function systemResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : 'error';
}
