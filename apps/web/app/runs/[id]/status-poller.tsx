'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FunnelStep } from '@auditor/shared';
import { stepProgress } from '@/lib/report-view.ts';

interface Props {
  runId: string;
  startedAt: string;
}

interface StatusPayload {
  status: string;
  events: Array<{ status: string; step?: string; at: string }>;
}

const TERMINAL = new Set(['succeeded', 'failed', 'timed_out']);

/**
 * While a run is queued or running: polls the run's JSON every 2 s, shows the furthest step
 * the worker has reported and the elapsed time, and asks the server component to re-render
 * once the run is terminal — the report itself is never assembled in the browser.
 */
export function StatusPoller({ runId, startedAt }: Props) {
  const router = useRouter();
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = setInterval(
      () => setElapsed(Math.floor((Date.now() - Date.parse(startedAt)) / 1000)),
      1000,
    );
    return () => clearInterval(tick);
  }, [startedAt]);

  useEffect(() => {
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as StatusPayload;
        if (stopped) return;
        setPayload(data);
        if (TERMINAL.has(data.status)) {
          router.refresh();
          return;
        }
      } catch {
        /* transient; try again on the next tick */
      }
      if (!stopped) setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [runId, router]);

  const status = payload?.status ?? 'queued';
  const furthest = payload?.events.find((e) => e.status === 'running' && e.step)?.step as
    FunnelStep | undefined;
  const steps = stepProgress(furthest ?? null, false);

  return (
    <section className="card mt-6 p-4" aria-live="polite">
      <p className="font-semibold">
        {status === 'queued'
          ? 'Queued — a browser is about to start'
          : 'Running — a browser is walking the funnel'}
        <span className="text-muted-foreground ml-2 font-normal">{elapsed}s</span>
      </p>
      <ol className="mt-3 flex flex-wrap gap-2 text-sm">
        {steps.map((s) => (
          <li
            key={s.step}
            className={
              s.state === 'done'
                ? 'pill pill-pass px-2 py-1 text-sm'
                : s.state === 'current'
                  ? 'pill bg-primary text-primary-foreground animate-pulse px-2 py-1 text-sm'
                  : 'pill pill-undecided px-2 py-1 text-sm font-normal'
            }
          >
            {s.label}
          </li>
        ))}
      </ol>
      <p className="text-muted-foreground mt-3 text-xs">
        Usually 30–90 seconds. This page updates itself; the link is stable if you want to come
        back.
      </p>
    </section>
  );
}
