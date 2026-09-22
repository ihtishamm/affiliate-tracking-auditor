import Link from 'next/link';
import type { OrderLine } from '@auditor/checks';
import { getDb } from '@/lib/db.ts';
import { getEnv } from '@/lib/env.ts';
import { log } from '@/lib/log.ts';
import { reconcileWindow, type ReconcileReport } from '@/lib/reconcile.ts';
import { parseWindow } from '@/lib/reconcile-window.ts';

export const dynamic = 'force-dynamic';

/**
 * The merchant's screen (§6 M7): Shopify's orders for a window against what the tracking
 * chain did for each. Server-rendered; the date form is a plain GET so the URL is the state.
 */
export default async function ReconcilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const k of ['from', 'to']) if (typeof sp[k] === 'string') params.set(k, sp[k] as string);
  const env = getEnv();
  const window = parseWindow(params);

  let report: ReconcileReport | null = null;
  let error: string | null = null;
  if (!env.SHOPIFY_ADMIN_TOKEN)
    error =
      'SHOPIFY_ADMIN_TOKEN is not configured: create a custom app with the read_orders scope and set its Admin API token.';
  else if ('error' in window) error = window.error;
  else {
    try {
      report = await reconcileWindow(window.from, window.to, {
        db: getDb(),
        storeDomain: env.SHOPIFY_STORE_DOMAIN,
        token: env.SHOPIFY_ADMIN_TOKEN,
        fetch,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log,
      });
    } catch (err) {
      log.error('reconcile page failed', { err });
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const day = (d: Date): string => d.toISOString().slice(0, 10);
  const from = 'from' in window ? day(window.from) : '';
  const to = 'to' in window ? day(window.to) : '';

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <Link href="/" className="text-sm text-muted-foreground hover:underline">
        ← Auditor
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Reconciliation</h1>
      <p className="mt-1 text-muted-foreground">
        Every order Shopify reports for the window, and whether each thing that should follow a sale
        actually happened: a click ID on the order, the webhook, the browser Purchase, the server
        Purchase, the postback. The first missing stage is the drop-off.
      </p>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3 text-sm">
        <label>
          From{' '}
          <input type="date" name="from" defaultValue={from} className="field ml-1 px-2 py-1" />
        </label>
        <label>
          To <input type="date" name="to" defaultValue={to} className="field ml-1 px-2 py-1" />
        </label>
        <button type="submit" className="btn btn-primary py-1.5">
          Reconcile
        </button>
        <span className="text-muted-foreground">UTC days, up to 31.</span>
      </form>

      {error && (
        <p className="card border-destructive bg-destructive/10 mt-6 border-2 p-4 text-sm">
          {error}
        </p>
      )}

      {report && (
        <>
          <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label="Orders" value={report.counts.orders} note="Shopify Admin API" />
            <Stat label="With click ID" value={report.counts.attributed} note="of orders" />
            <Stat label="Webhooks" value={report.counts.webhooks} note="received" />
            <Stat
              label="Browser Purchase"
              value={report.counts.pixelPurchases}
              note={`${report.counts.pixelUnknown} not watched`}
            />
            <Stat label="Server Purchase" value={report.counts.capi} note="CAPI accepted" />
            <Stat label="Postbacks" value={report.counts.postbacks} note="accepted" />
            <Stat
              label="Discrepancies"
              value={report.counts.discrepancies}
              note="orders with a gap"
              tone={report.counts.discrepancies ? 'bad' : 'good'}
            />
          </dl>

          <h2 className="mt-8 font-serif text-xl font-semibold">
            {report.counts.discrepancies === 0
              ? 'No gaps in this window'
              : `${report.counts.discrepancies} order${report.counts.discrepancies === 1 ? '' : 's'} with a gap`}
          </h2>
          {report.discrepancies.length > 0 && <OrderTable lines={report.discrepancies} />}

          <details className="mt-8">
            <summary className="cursor-pointer text-sm font-semibold">
              All {report.counts.orders} orders
            </summary>
            <div className="mt-3">
              <OrderTable lines={report.orders} />
            </div>
          </details>

          <p className="mt-8 text-xs text-muted-foreground">
            Window {report.window.from.slice(0, 10)} → {report.window.to.slice(0, 10)} ·{' '}
            {report.pages} Admin API page{report.pages === 1 ? '' : 's'}
            {report.throttle &&
              ` · cost bucket ${report.throttle.currentlyAvailable}/${report.throttle.maximumAvailable}, refills ${report.throttle.restoreRate}/s`}
            . Browser Purchases are known only for orders an auditor run placed; a real
            customer&apos;s order shows “not watched”, never “missing”.
          </p>
        </>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number;
  note: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div
      className={`card p-3 ${tone === 'bad' ? 'border-destructive bg-destructive/10 border-2' : tone === 'good' ? 'border-secondary bg-secondary/20 border-2' : ''}`}
    >
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-serif text-3xl font-semibold tabular-nums">{value}</dd>
      <dd className="text-muted-foreground text-xs">{note}</dd>
    </div>
  );
}

const STAGE_LABEL: Record<NonNullable<OrderLine['dropOff']>, string> = {
  no_click_id: 'No click ID on the order',
  webhook_missing: 'Webhook never received',
  pixel_missing: 'Browser Purchase never fired',
  capi_missing: 'Server Purchase not sent',
  postback_missing: 'Postback not accepted',
};

function Mark({ state }: { state: boolean | 'ok' | 'missing' | 'unknown' }) {
  const s = state === true ? 'ok' : state === false ? 'missing' : state;
  return (
    <span
      className={`pill px-1.5 py-0 ${
        s === 'ok' ? 'pill-pass' : s === 'missing' ? 'pill-fail' : 'pill-undecided'
      }`}
      title={s === 'unknown' ? 'not watched' : s}
    >
      {s === 'ok' ? '✓' : s === 'missing' ? '✗' : '?'}
    </span>
  );
}

function OrderTable({ lines }: { lines: OrderLine[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="card w-full p-2 text-sm">
        <thead className="text-muted-foreground text-left text-xs">
          <tr>
            <th className="py-1 pr-3">Order</th>
            <th className="py-1 pr-3">Created</th>
            <th className="py-1 pr-3">Click ID</th>
            <th className="py-1 pr-2 text-center">Webhook</th>
            <th className="py-1 pr-2 text-center">Browser</th>
            <th className="py-1 pr-2 text-center">CAPI</th>
            <th className="py-1 pr-2 text-center">Postback</th>
            <th className="py-1 pr-3">Drop-off</th>
            <th className="py-1">Run</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-t align-top">
              <td className="py-2 pr-3 font-mono">
                {l.name}
                <span className="block text-xs text-muted-foreground">{l.id}</span>
              </td>
              <td className="py-2 pr-3 whitespace-nowrap">
                {l.createdAt.slice(0, 16).replace('T', ' ')}
              </td>
              <td className="py-2 pr-3 font-mono">
                {l.clickId ?? <span className="pill pill-fail px-1.5 py-0">—</span>}
              </td>
              <td className="py-2 pr-2 text-center">
                <Mark state={l.webhook} />
              </td>
              <td className="py-2 pr-2 text-center">
                <Mark state={l.pixel} />
              </td>
              <td className="py-2 pr-2 text-center">
                <Mark state={l.capi} />
              </td>
              <td className="py-2 pr-2 text-center">
                <Mark state={l.postback} />
              </td>
              <td className="py-2 pr-3">
                {l.dropOff ? (
                  <>
                    <span className="pill pill-fail">{STAGE_LABEL[l.dropOff]}</span>
                    <span className="text-muted-foreground mt-1 block text-xs">{l.why}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">{l.why}</span>
                )}
              </td>
              <td className="py-2">
                {l.runId ? (
                  <Link className="underline" href={`/runs/${l.runId}`}>
                    report
                  </Link>
                ) : (
                  ''
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
