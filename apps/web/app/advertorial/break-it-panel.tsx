'use client';

import {
  BREAK_PARAM,
  BREAK_TOGGLES,
  BREAK_TOGGLE_INFO,
  serializeBreakToggles,
  type BreakToggle,
} from '@auditor/shared';

interface Props {
  active: readonly BreakToggle[];
  /** The CTA's current href, shown so a reviewer can see exactly what the redirect will receive. */
  ctaHref: string;
}

/**
 * Sabotage switches for the demo funnel. Flipping one rewrites `__break` in this page's URL and
 * reloads: a full navigation, so the advertorial pixel behaves exactly as it would on a fresh
 * visit, and the CTA below carries the new state into the store.
 */
export function BreakItPanel({ active, ctaHref }: Props) {
  function flip(toggle: BreakToggle) {
    const url = new URL(window.location.href);
    const next = new Set(active);
    if (next.has(toggle)) next.delete(toggle);
    else next.add(toggle);
    const value = serializeBreakToggles(next);
    if (value) url.searchParams.set(BREAK_PARAM, value);
    else url.searchParams.delete(BREAK_PARAM);
    window.location.assign(url.toString());
  }

  return (
    <aside className="rounded border border-red-300 bg-red-50 p-4 text-sm">
      <h2 className="font-semibold text-red-900">Break-it panel</h2>
      <p className="mt-1 text-red-800">
        Each switch sabotages the funnel in one realistic way. Flip one, walk the funnel, and the
        named check must catch it.
      </p>
      <ul className="mt-3 space-y-3">
        {BREAK_TOGGLES.map((toggle) => {
          const info = BREAK_TOGGLE_INFO[toggle];
          const on = active.includes(toggle);
          return (
            <li key={toggle} className="flex gap-3">
              <input
                id={`break-${toggle}`}
                type="checkbox"
                checked={on}
                onChange={() => flip(toggle)}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <label htmlFor={`break-${toggle}`} className="cursor-pointer">
                <span className="font-medium text-neutral-900">{info.label}</span>
                <span className="ml-2 font-mono text-xs text-neutral-500">{toggle}</span>
                <span className="ml-2 text-xs text-neutral-600">
                  check {info.caughtBy.join(', ')} · {info.actsIn}
                  {info.requires ? ` · active from ${info.requires}` : ''}
                </span>
                <p className="mt-0.5 text-neutral-700">{info.breaks}</p>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-xs text-neutral-600">CTA currently points at</p>
      <code className="mt-1 block break-all rounded bg-white p-2 text-xs text-neutral-800">
        {ctaHref}
      </code>
    </aside>
  );
}
