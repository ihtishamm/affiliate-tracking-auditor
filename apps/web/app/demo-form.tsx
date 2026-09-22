'use client';

import { useState } from 'react';
import {
  BREAK_PARAM,
  BREAK_TOGGLES,
  BREAK_TOGGLE_INFO,
  serializeBreakToggles,
  type BreakToggle,
} from '@auditor/shared';

interface Props {
  /** Absolute URL of the demo advertorial on this deployment. */
  advertorialUrl: string;
  idempotencyKey: string;
}

/**
 * Audit the demo funnel, optionally sabotaged. Plain form POST like the main form; the only
 * JavaScript is composing `?__break=` from the checkboxes into the hidden `url` field, so the
 * reviewer can flip a switch and submit without visiting the advertorial. Without JavaScript
 * the form still submits the clean demo URL.
 */
export function DemoForm({ advertorialUrl, idempotencyKey }: Props) {
  const [active, setActive] = useState<Set<BreakToggle>>(new Set());
  const url = new URL(advertorialUrl);
  const value = serializeBreakToggles(active);
  if (value) url.searchParams.set(BREAK_PARAM, value);
  const flip = (t: BreakToggle) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  return (
    <form method="post" action="/api/runs" className="card p-5">
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <input type="hidden" name="url" value={url.toString()} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Or audit the demo funnel</h2>
        <button type="submit" className="btn btn-secondary text-sm">
          {active.size
            ? `Audit with ${active.size} thing${active.size === 1 ? '' : 's'} broken`
            : 'Audit the clean demo'}
        </button>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        A real advertorial → redirect → Shopify store → checkout, that we own. Tick a switch to
        break it in one realistic way; the report names the check that catches it.
      </p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-3">
        {BREAK_TOGGLES.map((t) => {
          const info = BREAK_TOGGLE_INFO[t];
          return (
            <li key={t}>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={active.has(t)}
                  onChange={() => flip(t)}
                />
                <span>
                  <span className="font-medium">{info.label}</span>
                  <span className="text-muted-foreground block text-xs">
                    caught by check {info.caughtBy.join(' and ')}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground mt-3 font-mono text-xs break-all">{url.toString()}</p>
    </form>
  );
}
