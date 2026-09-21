import { z } from 'zod';

const MAX_DAYS = 31;

const querySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

/**
 * The window a reconcile request asks for: `from`/`to` as YYYY-MM-DD, defaulting to the last
 * 7 days, capped at 31 days so one request cannot page through a year of orders. Dates are
 * whole UTC days: `to` runs to the end of its day.
 */
export function parseWindow(params: URLSearchParams): { from: Date; to: Date } | { error: string } {
  const parsed = querySchema.safeParse({
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
  });
  if (!parsed.success) return { error: 'from and to must be dates as YYYY-MM-DD' };
  const now = new Date();
  const to = parsed.data.to ? new Date(`${parsed.data.to}T23:59:59.999Z`) : now;
  const from = parsed.data.from
    ? new Date(`${parsed.data.from}T00:00:00.000Z`)
    : new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  if (from > to) return { error: 'from must be before to' };
  if (to.getTime() - from.getTime() > MAX_DAYS * 24 * 3600 * 1000)
    return { error: `window is capped at ${MAX_DAYS} days` };
  return { from, to };
}
