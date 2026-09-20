// Turns a full run trace into a test fixture: keeps every hop and snapshot, and only the
// requests the checks read (Meta pixel, tag containers, cart attribute writes, postbacks,
// navigations). Everything else — Shopify telemetry, fonts, chunks — is dropped, taking a
// 1.5 MB trace to a few tens of KB. Usage:
//
//   node scripts/slim-trace.ts <api-base>/api/runs/<id>?trace=1 test/fixtures/<name>.json
//
// The fixture is a real, redacted trace; nothing in it was typed by hand.
import { writeFileSync } from 'node:fs';
import { runTraceSchema, type RunTrace, type TraceRequest } from '@auditor/shared';

const KEEP_HOST =
  /(^|\.)(facebook\.com|facebook\.net|googletagmanager\.com|google-analytics\.com)$/;
const KEEP_PATH = /\/cart\/(update|add)(\.js)?$|\/api\/postback$|\/go$/;
const DROP_PARAM =
  /^(expv2|ss|pmd|sw|sh|coo|es|hme|it|rl|rqm|sc|ts|tm|ec|o|r|v|ler|cs_est|dpo|dpoco|dpost|aems|nsmpg)(\[|$)/;

function keep(r: TraceRequest): boolean {
  return r.navigation || KEEP_HOST.test(r.host) || KEEP_PATH.test(r.url);
}

function slimRequest(r: TraceRequest): TraceRequest {
  const params: TraceRequest['params'] = {};
  for (const [k, v] of Object.entries(r.params)) if (!DROP_PARAM.test(k)) params[k] = v;
  return { ...r, params };
}

export function slimTrace(trace: RunTrace): RunTrace {
  return runTraceSchema.parse({
    ...trace,
    requests: trace.requests.filter(keep).map(slimRequest),
    steps: trace.steps.map((s) => ({
      ...s,
      scripts: s.scripts.filter((u) =>
        /googletagmanager|google-analytics|facebook|fbevents|gtm|gtag/.test(u),
      ),
    })),
  });
}

const [source, target] = process.argv.slice(2);
if (source && target) {
  const res = await fetch(source);
  const body = (await res.json()) as { trace: RunTrace };
  const slim = slimTrace(body.trace);
  writeFileSync(target, JSON.stringify(slim, null, 1) + '\n');
  console.log(
    `${target}: ${slim.requests.length} requests, ${slim.hops.length} hops, ${slim.steps.length} steps, ${Buffer.byteLength(JSON.stringify(slim))} bytes`,
  );
}
