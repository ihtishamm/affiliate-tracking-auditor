import type { RunTrace } from '@auditor/shared';
import { waterfallRows, type WaterfallRow } from '@/lib/report-view.ts';

const ROW = 18;
const LABEL_W = 230;
const CHART_W = 620;
// Chart colours come from the theme's chart tokens rather than fixed hexes, so the timeline
// stays part of the palette (and follows it if the palette changes). Blocked hops are the one
// exception: they borrow --destructive, because "refused" means the same here as everywhere.
const COLORS: Record<WaterfallRow['kind'], string> = {
  hop: 'var(--muted-foreground)',
  pixel: 'var(--chart-1)',
  container: 'var(--chart-3)',
  cart: 'var(--chart-2)',
  postback: 'var(--chart-5)',
};

/**
 * The network trace as a timeline, server-rendered as inline SVG: main-frame hops as bars
 * spanning until the next hop, tracking and attribution requests as marks on the same axis.
 * Hover any row for the redacted detail. No chart library: the point is to see *when* each
 * pixel fired relative to each page, and a few rectangles do that.
 */
export function Waterfall({ trace }: { trace: RunTrace }) {
  const rows = waterfallRows(trace);
  if (rows.length === 0) return null;
  const total = Math.max(Date.parse(trace.finishedAt) - Date.parse(trace.startedAt), 1);
  const x = (t: number): number => LABEL_W + (Math.min(Math.max(t, 0), total) / total) * CHART_W;
  const height = rows.length * ROW + 24;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * total);

  return (
    <figure className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${LABEL_W + CHART_W + 10} ${height}`}
        className="w-full min-w-[640px] text-[11px]"
        role="img"
        aria-label="Network waterfall: page hops and tracking requests over time"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={x(t)}
              y1={16}
              x2={x(t)}
              y2={height}
              stroke="var(--border)"
              strokeOpacity={0.3}
            />
            <text x={x(t)} y={11} textAnchor="middle" fill="var(--muted-foreground)">
              {(t / 1000).toFixed(0)}s
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const y = 20 + i * ROW;
          const x1 = x(r.t);
          const w = r.kind === 'hop' ? Math.max(x(r.end) - x1, 2) : 4;
          const fill = r.blocked ? 'var(--destructive)' : COLORS[r.kind];
          return (
            <g key={i}>
              <title>{`${r.label} — ${r.detail} — at ${(r.t / 1000).toFixed(2)}s`}</title>
              <text
                x={LABEL_W - 8}
                y={y + 12}
                textAnchor="end"
                fill={r.kind === 'hop' ? 'var(--foreground)' : 'var(--muted-foreground)'}
                fontWeight={r.kind === 'hop' ? 600 : 400}
              >
                {r.label.length > 38 ? `…${r.label.slice(-37)}` : r.label}
              </text>
              <rect
                x={x1}
                y={y + 3}
                width={w}
                height={ROW - 6}
                rx={2}
                fill={fill}
                opacity={r.kind === 'hop' ? 0.35 : 0.95}
              />
              {r.kind === 'hop' && r.status !== null && (
                <text x={x1 + 4} y={y + 12} fill="var(--foreground)">
                  {r.status}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="text-muted-foreground mt-2 flex flex-wrap gap-4 text-xs">
        <span>
          <i className="bg-muted-foreground mr-1 inline-block h-2 w-3 align-middle" />
          page hop
        </span>
        <span>
          <i className="bg-chart-1 mr-1 inline-block h-2 w-3 align-middle" />
          Meta pixel
        </span>
        <span>
          <i className="bg-chart-3 mr-1 inline-block h-2 w-3 align-middle" />
          tag container
        </span>
        <span>
          <i className="bg-chart-2 mr-1 inline-block h-2 w-3 align-middle" />
          cart attributes
        </span>
        <span>
          <i className="bg-chart-5 mr-1 inline-block h-2 w-3 align-middle" />
          postback
        </span>
        <span>
          <i className="bg-destructive mr-1 inline-block h-2 w-3 align-middle" />
          blocked
        </span>
        <span>· hover a row for details · {trace.requests.length} requests in total</span>
      </figcaption>
    </figure>
  );
}
