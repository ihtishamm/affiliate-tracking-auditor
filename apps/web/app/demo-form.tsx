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
    <form method="post" action="/api/runs" className="rounded border border-neutral-200 p-4">
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <input type="hidden" name="url" value={url.toString()} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Or audit the demo funnel</h2>
        <button
          type="submit"
          className="rounded bg-green-700 px-4 py-2 text-sm font-semibold text-white hover:bg-green-800"
        >
          {active.size
            ? `Audit with ${active.size} thing${active.size === 1 ? '' : 's'} broken`
            : 'Audit the clean demo'}
        </button>
      </div>
      <p className="mt-1 text-sm text-neutral-600">
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
                  <span className="block text-xs text-neutral-500">
                    caught by check {info.caughtBy.join(' and ')}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 break-all font-mono text-xs text-neutral-500">{url.toString()}</p>
    </form>
  );
}
