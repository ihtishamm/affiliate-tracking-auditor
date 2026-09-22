import Link from 'next/link';
import {
  ATTRIBUTION_PARAMS,
  BREAK_PARAM,
  CLICK_ID_PARAM,
  parseBreakToggles,
  serializeBreakToggles,
} from '@auditor/shared';
import { getEnv } from '@/lib/env.ts';
import { AdvertorialPixel } from './advertorial-pixel.tsx';
import { BreakItPanel } from './break-it-panel.tsx';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A mock affiliate advertorial: the first page of a duplicate funnel. It arrives with the
 * network's click_id and UTMs in its URL, and its job is to hand them on to the store through
 * /go. Every paragraph is filler; the CTA and what it carries are the point.
 */
export default async function AdvertorialPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const env = getEnv();
  const toggles = parseBreakToggles(first(params[BREAK_PARAM]));

  const attribution: Record<string, string> = {};
  for (const key of ATTRIBUTION_PARAMS) {
    const value = first(params[key]);
    if (value) attribution[key] = value;
  }

  const go = new URLSearchParams(attribution);
  if (toggles.length > 0) go.set(BREAK_PARAM, serializeBreakToggles(toggles));
  go.set('path', '/collections/all'); // exists on every Shopify store
  const ctaHref = `/go?${go.toString()}`;

  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-4 py-10 lg:grid-cols-[1fr_20rem]">
      <article className="max-w-2xl font-serif">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Advertorial · demo funnel
        </p>
        <h1 className="mt-2 font-serif text-4xl leading-tight font-bold">
          I swapped my morning coffee for this greens powder for 30 days. Here is what changed.
        </h1>
        <p className="mt-4 text-foreground/90">
          Like most people I had a drawer full of half-used supplements. What finally stuck was a
          single scoop in water before anything else. No claims here you would not read on the tin;
          this is a demo page whose only real job is the button below.
        </p>
        <Cta href={ctaHref} />
        <p className="mt-6 text-foreground/90">
          The part that matters to this project is invisible: the link you arrived on carried an
          affiliate click ID and campaign parameters, and the button forwards them into the store
          through a redirect. That redirect is where attribution silently dies on real duplicate
          funnels, and the panel on the right lets you make it die on purpose.
        </p>
        <p className="mt-4 text-foreground/90">
          Walk the funnel once clean, then flip a switch and walk it again. Each switch is annotated
          with the auditor check that must catch it.
        </p>
        <Cta href={ctaHref} />
      </article>

      <div className="space-y-4">
        <section className="card p-4 text-sm">
          <h2 className="font-semibold">Attribution on this page</h2>
          <dl className="mt-2 space-y-1 font-mono text-xs">
            {ATTRIBUTION_PARAMS.map((key) => (
              <div key={key} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className={attribution[key] ? 'text-foreground' : 'pill pill-fail px-1.5 py-0'}>
                  {attribution[key] ?? '—'}
                </dd>
              </div>
            ))}
          </dl>
          {!attribution[CLICK_ID_PARAM] && (
            <p className="mt-3 text-xs text-muted-foreground">
              No click_id in the URL. Open this page as an affiliate link would, e.g.{' '}
              <Link
                className="underline"
                href="/advertorial?click_id=demo-001&utm_source=affiliate&utm_medium=cpc&utm_campaign=demo"
              >
                with demo parameters
              </Link>
              .
            </p>
          )}
        </section>
        <BreakItPanel active={toggles} ctaHref={ctaHref} />
        <p className="text-xs text-muted-foreground">Store: {env.SHOPIFY_STORE_DOMAIN}</p>
      </div>

      <AdvertorialPixel pixelId={env.META_PIXEL_ID} toggles={toggles} />
    </main>
  );
}

function Cta({ href }: { href: string }) {
  // A plain anchor, on purpose: the hop into the store must be an ordinary navigation the
  // auditor's browser follows, not a client-side router transition.
  return (
    <p className="mt-6">
      <a href={href} className="btn btn-primary px-5 py-3 text-lg">
        Get 20% off your first tub →
      </a>
    </p>
  );
}
