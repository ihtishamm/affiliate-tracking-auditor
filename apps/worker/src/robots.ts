import type { RunTrace } from '@auditor/shared';

export type RobotsVerdict = RunTrace['robots'];

/** The token this crawler answers to in a robots.txt group, besides `*`. */
export const ROBOTS_AGENT = 'AffiliateTrackingAuditor';

/**
 * Fetches and evaluates robots.txt for one path (§9: "not a legal shield but check it anyway
 * and surface the result"). The verdict is recorded in the trace and shown in the report; it
 * never stops a run, because the person submitting the URL is, in the intended use, its
 * owner. Only the standard is implemented: user-agent groups, Allow/Disallow, longest match
 * wins, Allow beats Disallow on a tie. A 30-line parser instead of a dependency.
 */
export async function checkRobots(
  target: URL,
  fetchImpl: typeof fetch = fetch,
): Promise<RobotsVerdict> {
  const robotsUrl = new URL('/robots.txt', target.origin);
  let status: number | null = null;
  let text: string;
  try {
    const res = await fetchImpl(robotsUrl, {
      headers: { 'user-agent': `${ROBOTS_AGENT}/1.0` },
      signal: AbortSignal.timeout(4_000),
      redirect: 'follow',
    });
    status = res.status;
    if (!res.ok) {
      // 4xx means "no robots.txt": everything allowed. 5xx means we cannot know.
      return { fetched: true, status, allowed: status < 500 ? true : null, matchedRule: null };
    }
    text = (await res.text()).slice(0, 512 * 1024);
  } catch {
    return { fetched: false, status, allowed: null, matchedRule: null };
  }
  return { fetched: true, status, ...evaluate(text, target.pathname + target.search) };
}

interface Rule {
  allow: boolean;
  path: string;
}

/** Exported for the tests; pure. */
export function evaluate(
  robotsTxt: string,
  path: string,
): { allowed: boolean; matchedRule: string | null } {
  const groups = parseGroups(robotsTxt);
  // The most specific group wins: our own token, else `*`. No group means no restrictions.
  const ours = groups.filter((g) => g.agents.some((a) => a === ROBOTS_AGENT.toLowerCase()));
  const wild = groups.filter((g) => g.agents.includes('*'));
  const rules = (ours.length > 0 ? ours : wild).flatMap((g) => g.rules);
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!matches(rule.path, path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow)
    ) {
      best = rule;
    }
  }
  if (!best) return { allowed: true, matchedRule: null };
  return { allowed: best.allow, matchedRule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` };
}

function parseGroups(text: string): Array<{ agents: string[]; rules: Rule[] }> {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      if (value === '' && field === 'disallow') continue; // "Disallow:" (empty) allows all
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  return groups;
}

/** robots.txt patterns: `*` wildcard, `$` end anchor, prefix match otherwise. */
function matches(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = pattern.endsWith('$') ? `^${escaped.slice(0, -2)}$` : `^${escaped}`;
  return new RegExp(re).test(path);
}
