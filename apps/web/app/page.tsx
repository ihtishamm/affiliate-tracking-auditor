export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-semibold">Affiliate Tracking Auditor</h1>
      <p className="mt-3 text-neutral-600">
        Paste an affiliate funnel URL, get a pass/fail tracking report with the exact broken line.
        The run form arrives in M6; this is the M0 deployment skeleton.
      </p>
      <p className="mt-6">
        <a
          className="inline-block rounded bg-neutral-900 px-4 py-2 text-sm font-semibold text-white"
          href="/advertorial?click_id=demo-001&utm_source=affiliate&utm_medium=cpc&utm_campaign=demo"
        >
          Open the demo funnel →
        </a>
      </p>
      <p className="mt-6 text-sm text-neutral-500">
        Health:{' '}
        <a className="underline" href="/api/health">
          /api/health
        </a>
      </p>
    </main>
  );
}
