import { signHex, type Logger } from '@auditor/shared';

// The alert delivery (§6 M8: "one webhook, nothing fancier"). One POST, one attempt, five
// seconds; the outcome is written onto the alert row. No retry loop: an alert is a nudge to
// look at the report, and a receiver that is down will see the next day's alert if the
// regression persists. The body is one shape for every receiver; `content` (Discord) and
// `text` (Slack) carry the one-line summary, the rest is for anything that reads JSON.

export interface AlertPayload {
  type: 'funnel_alert';
  funnel: { id: string; label: string; url: string };
  run_id: string;
  report_url: string | null;
  previous_score: number | null;
  score: number | null;
  reasons: string[];
  flipped: string[];
  fired_at: string;
}

export interface AlertWebhookDeps {
  url: string;
  secret: string | undefined;
  fetch: typeof fetch;
  log: Logger;
}

export function summaryLine(p: AlertPayload): string {
  const pct = (s: number | null): string => (s === null ? '—' : `${Math.round(s * 100)}%`);
  return `Affiliate audit: "${p.funnel.label}" regressed (${pct(p.previous_score)} → ${pct(p.score)}): ${p.reasons.join('; ')}${p.report_url ? ` — ${p.report_url}` : ''}`;
}

export async function sendAlert(
  payload: AlertPayload,
  deps: AlertWebhookDeps,
): Promise<{ status: number | null; error: string | null }> {
  const line = summaryLine(payload);
  const body = JSON.stringify({ ...payload, content: line, text: line });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (deps.secret) headers['x-auditor-signature'] = signHex(deps.secret, body);
  try {
    const res = await deps.fetch(deps.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(5_000),
    });
    const outcome = { status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
    (res.ok ? deps.log.info : deps.log.warn).call(deps.log, 'alert webhook', {
      ...outcome,
      funnel: payload.funnel.id,
    });
    return outcome;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    deps.log.warn('alert webhook failed', { error, funnel: payload.funnel.id });
    return { status: null, error };
  }
}
