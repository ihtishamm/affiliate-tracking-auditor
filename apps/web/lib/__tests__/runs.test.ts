import { describe, expect, it } from 'vitest';
import { createLogger, type RunJob } from '@auditor/shared';
import { submitRun, type SubmitDeps } from '../runs.ts';

const log = createLogger({ service: 'test', level: 'error', write: () => {} });
const resolve = async (host: string): Promise<string[]> =>
  host === 'shop.example' ? ['203.0.113.10'] : ['10.0.0.5'];

function harness(overrides: Partial<SubmitDeps> = {}) {
  const runs = new Map<string, string>();
  const events: Array<{ runId: string; status: string }> = [];
  const jobs: RunJob[] = [];
  let nextId = 0;
  const deps: SubmitDeps = {
    insertRun: async (run) => {
      const existing = runs.get(run.idempotencyKey);
      if (existing) return { id: existing, created: false };
      const id = `00000000-0000-4000-8000-00000000000${nextId++}`;
      runs.set(run.idempotencyKey, id);
      return { id, created: true };
    },
    appendEvent: async (runId, status) => {
      events.push({ runId, status });
    },
    enqueue: async (job) => {
      jobs.push(job);
    },
    queueDepth: async () => 0,
    rateLimit: async () => 0,
    ssrf: { resolve },
    purchaseHost: 'auditor-demo.myshopify.com',
    log,
    ...overrides,
  };
  return { deps, runs, events, jobs };
}

const good = { url: 'https://shop.example/landing?click_id=abc', idempotency_key: 'form-key-0001' };

describe('submitRun', () => {
  it('queues a valid URL: one run row, one queued event, one job carrying the purchase host', async () => {
    const h = harness();
    const out = await submitRun(good, 'client-a', h.deps);
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ status: 'queued', deduplicated: false });
    expect(h.events).toEqual([{ runId: expect.any(String), status: 'queued' }]);
    expect(h.jobs[0]).toMatchObject({
      url: 'https://shop.example/landing?click_id=abc',
      clickIdParam: 'click_id',
      purchaseHost: 'auditor-demo.myshopify.com',
    });
  });

  it('IDEMPOTENT: the same key twice returns the same run and enqueues nothing new', async () => {
    const h = harness();
    const a = await submitRun(good, 'client-a', h.deps);
    const b = await submitRun(good, 'client-a', h.deps);
    expect(a.status === 202 && b.status === 202 && a.body.run_id === b.body.run_id).toBe(true);
    expect(b.body).toMatchObject({ deduplicated: true });
    expect(h.jobs).toHaveLength(1);
    expect(h.events).toHaveLength(1);
  });

  it('rejects malformed input before doing any I/O', async () => {
    const h = harness({
      rateLimit: async () => {
        throw new Error('should not be called');
      },
    });
    const out = await submitRun({ url: '', idempotency_key: 'short' }, 'c', h.deps);
    expect(out.status).toBe(400);
    expect(out.status === 400 && out.body.issues.join(' ')).toMatch(/url/);
  });

  it('rate limit is checked before DNS, and answers with retry-after seconds', async () => {
    const h = harness({
      rateLimit: async () => 1234,
      ssrf: {
        resolve: async () => {
          throw new Error('DNS must not run for a rate-limited client');
        },
      },
    });
    const out = await submitRun(good, 'client-b', h.deps);
    expect(out).toEqual({
      status: 429,
      body: { error: 'rate_limited', retry_after_seconds: 1234 },
    });
    expect(h.jobs).toHaveLength(0);
  });

  it('SSRF: a URL resolving to a private address is refused with the reason, nothing stored', async () => {
    const h = harness();
    const out = await submitRun({ ...good, url: 'https://internal.example/' }, 'c', h.deps);
    expect(out.status).toBe(422);
    expect(out.status === 422 && out.body.reason).toMatch(/private address 10\.0\.0\.5/);
    expect(h.runs.size).toBe(0);
  });

  it('a full queue is 503 busy, not a silently delayed run', async () => {
    const h = harness({ queueDepth: async () => 20 });
    expect((await submitRun(good, 'c', h.deps)).status).toBe(503);
  });

  it('the stored and queued URL has PII-looking query values redacted', async () => {
    const h = harness();
    await submitRun(
      { ...good, url: 'https://shop.example/l?click_id=abc&email=jane@example.org' },
      'c',
      h.deps,
    );
    expect(h.jobs[0]?.url).toBe('https://shop.example/l?click_id=abc&email=%5Bredacted%5D');
  });

  it('accepts a custom click-id parameter name, within its character set', async () => {
    const h = harness();
    const ok = await submitRun({ ...good, click_id_param: 'aff_sub[1]' }, 'c', h.deps);
    expect(ok.status).toBe(202);
    expect(h.jobs[0]?.clickIdParam).toBe('aff_sub[1]');
    const bad = await submitRun(
      { ...good, idempotency_key: 'form-key-0002', click_id_param: 'a b' },
      'c',
      h.deps,
    );
    expect(bad.status).toBe(400);
  });
});
