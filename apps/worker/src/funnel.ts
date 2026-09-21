import type { Locator, Page } from 'playwright';
import type { FunnelStep, Logger, RunTrace } from '@auditor/shared';
import { findCtaInPage, type CtaPick } from './in-page.ts';
import type { TraceCollector } from './trace.ts';

// The funnel driver: what a shopper does, done by a browser, one bounded step at a time.
// landing → CTA → store → product → cart → checkout, and — only on the host we own — payment
// → thank-you. Every step either advances or ends the run with a reason that names the step;
// the checks (M5) then know exactly how far the evidence goes and report the rest as
// `inconclusive` rather than guessing (§3).
//
// Why the purchase is gated on `purchaseHost`: completing checkout on a stranger's store
// would place a real order with a real payment attempt. The dev store runs the Bogus
// Gateway, where card number `1` is an approved test payment; nowhere else is that true.

const STEP_TIMEOUT_MS = 15_000;
const CHECKOUT_TIMEOUT_MS = 25_000;

export interface FunnelIdentity {
  email: string;
  firstName: string;
  lastName: string;
  address1: string;
  city: string;
  zone: string;
  postalCode: string;
}

export interface FunnelDeps {
  page: Page;
  collector: TraceCollector;
  purchaseHost: string | null;
  storefrontPassword: string | undefined;
  identity: FunnelIdentity;
  log: Logger;
  /** Called as each step begins, so the run's status can show progress while it runs. */
  onStep?: (step: FunnelStep) => void;
}

export interface FunnelResult {
  reachedStep: FunnelStep;
  stopReason: string;
  mode: RunTrace['mode'];
  cta: RunTrace['cta'];
}

class StopRun extends Error {
  readonly step: FunnelStep;
  constructor(step: FunnelStep, reason: string) {
    super(reason);
    this.step = step;
  }
}

export async function driveFunnel(entryUrl: string, deps: FunnelDeps): Promise<FunnelResult> {
  const { page, collector, log } = deps;
  const enter = (step: FunnelStep): void => {
    collector.setStep(step);
    deps.onStep?.(step);
  };
  let cta: RunTrace['cta'] = null;
  let mode: RunTrace['mode'] = 'observe';
  let reached: FunnelStep = 'landing';

  try {
    // ---- landing ----
    enter('landing');
    await page.goto(entryUrl, { waitUntil: 'load', timeout: STEP_TIMEOUT_MS });
    await settle(page);
    if (collector.blocked) throw new StopRun('landing', `blocked: ${collector.blocked}`);
    await collector.snapshot(page, 'landing');

    // ---- CTA ----
    reached = 'cta';
    enter('cta');
    const pick = await findCta(page);
    if (!pick) throw new StopRun('landing', 'no call-to-action link found on the landing page');
    cta = { rule: pick.rule, href: pick.href, text: pick.text };
    log.info('cta found', { rule: cta.rule, text: cta.text });
    const before = page.url();
    await Promise.all([
      page.waitForURL((u) => u.href !== before, { timeout: STEP_TIMEOUT_MS, waitUntil: 'load' }),
      page.locator('a[href]').nth(pick.index).click({ timeout: 5_000 }),
    ]).catch((err: unknown) => {
      if (collector.blocked) throw new StopRun('cta', `blocked: ${collector.blocked}`);
      throw new StopRun('cta', `following the CTA failed: ${message(err)}`);
    });
    await settle(page);

    // ---- store ----
    reached = 'store';
    enter('store');
    if (collector.blocked) throw new StopRun('cta', `blocked: ${collector.blocked}`);
    await passStorefrontPassword(page, deps);
    await collector.snapshot(page, 'store');

    // ---- product ----
    reached = 'product';
    enter('product');
    if (!/\/products\//.test(page.url())) {
      const link = page.locator('a[href*="/products/"]:visible').first();
      if ((await link.count()) === 0)
        throw new StopRun('store', 'no product link found on the store page');
      await followLink(page, link, /\/products\//).catch((err: unknown) => {
        throw new StopRun('store', `opening a product failed: ${message(err)}`);
      });
    }
    await settle(page);
    // A sold-out product cannot be added; try the next few the store links to before giving up.
    let add = await purchasableAddButton(page);
    if (!add) {
      const origin = new URL(page.url()).origin;
      for (const href of await otherProductHrefs(page, 4)) {
        await page.goto(new URL(href, origin).toString(), {
          waitUntil: 'load',
          timeout: STEP_TIMEOUT_MS,
        });
        await settle(page);
        add = await purchasableAddButton(page);
        if (add) break;
      }
    }
    await collector.snapshot(page, 'product');

    // ---- cart ----
    reached = 'cart';
    enter('cart');
    if (!add)
      throw new StopRun(
        'product',
        'no purchasable product found (add-to-cart missing or sold out)',
      );
    await Promise.all([
      page.waitForResponse((r) => /\/cart\/add/.test(r.url()) && r.request().method() === 'POST', {
        timeout: STEP_TIMEOUT_MS,
      }),
      add.click({ timeout: 5_000 }),
    ]).catch((err: unknown) => {
      throw new StopRun('product', `add to cart failed: ${message(err)}`);
    });
    await page.goto(new URL('/cart', page.url()).toString(), {
      waitUntil: 'load',
      timeout: STEP_TIMEOUT_MS,
    });
    await settle(page);
    await collector.snapshot(page, 'cart');

    // ---- checkout ----
    reached = 'checkout';
    enter('checkout');
    const checkoutButton = page
      .locator('button[name="checkout"], a[href*="/checkout"], [data-checkout]')
      .first();
    const toCheckout =
      (await checkoutButton.count()) > 0
        ? checkoutButton.click({ timeout: 5_000 })
        : page
            .goto(new URL('/checkout', page.url()).toString(), { timeout: CHECKOUT_TIMEOUT_MS })
            .then(() => undefined);
    await Promise.all([
      page.waitForURL(/\/checkouts?\//, { timeout: CHECKOUT_TIMEOUT_MS, waitUntil: 'load' }),
      toCheckout,
    ]).catch((err: unknown) => {
      throw new StopRun('cart', `reaching checkout failed: ${message(err)}`);
    });
    await settle(page, 6_000);
    await collector.snapshot(page, 'checkout');

    const host = new URL(page.url()).hostname;
    if (!deps.purchaseHost || host !== deps.purchaseHost) {
      return {
        reachedStep: 'checkout',
        stopReason: `observe mode: checkout reached on ${host}; purchases are only completed on the demo store`,
        mode,
        cta,
      };
    }

    // ---- payment (demo store only) ----
    reached = 'payment';
    mode = 'purchase';
    enter('payment');
    // Everything about to be typed, so any echo of it (checkout telemetry, address
    // autocomplete) is redacted wherever it appears.
    const id = deps.identity;
    collector.setKnownIdentity({
      email: id.email,
      values: [
        id.firstName,
        id.lastName,
        `${id.firstName} ${id.lastName}`,
        id.address1,
        id.city,
        id.postalCode,
      ],
    });
    await fillCheckout(page, deps.identity);
    await collector.snapshot(page, 'payment');

    // ---- thank you ----
    reached = 'thank_you';
    enter('thank_you');
    await payAndWait(page).catch((err: unknown) => {
      throw new StopRun('payment', `payment did not complete: ${message(err)}`);
    });
    // The Purchase pixel hit is the one observation this step exists for, and the checkout
    // pixel sandbox can take longer to fire it than a network-idle wait allows. Wait for it,
    // bounded; a Purchase that never fires is a finding for the checks, not an error here.
    await waitUntil(() => collector.orderFromTrace() !== null, 20_000);
    await settle(page, 3_000);
    await collector.snapshot(page, 'thank_you');
    return { reachedStep: 'thank_you', stopReason: 'purchase completed', mode, cta };
  } catch (err) {
    if (err instanceof StopRun) {
      log.info('funnel stopped', { step: err.step, reason: err.message });
      return { reachedStep: err.step, stopReason: err.message, mode, cta };
    }
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      reachedStep: reached,
    });
  }
}

/**
 * Follows a link the way a shopper ends up on the page: a click when the element can take
 * one, otherwise a direct navigation to its href. Themes routinely stack an image or an
 * overlay over the card's anchor (Horizon does), which fails Playwright's "receives events"
 * check while a human's click still works via the theme's JavaScript. What matters to the
 * checks is the page and its tracking, not the input method.
 */
async function followLink(page: Page, link: Locator, urlPattern: RegExp): Promise<void> {
  const href = await link.getAttribute('href');
  try {
    await Promise.all([
      page.waitForURL(urlPattern, { timeout: STEP_TIMEOUT_MS, waitUntil: 'load' }),
      link.click({ timeout: 3_000 }),
    ]);
  } catch (err) {
    if (!href) throw err;
    await page.goto(new URL(href, page.url()).toString(), {
      waitUntil: 'load',
      timeout: STEP_TIMEOUT_MS,
    });
    if (!urlPattern.test(page.url())) throw err;
  }
}

/** Polls `predicate` every 250 ms until it holds or `ms` elapse. Resolves either way. */
async function waitUntil(predicate: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Lets late trackers fire: wait for network idle, but never longer than `ms`. */
async function settle(page: Page, ms = 4_000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => undefined);
}

async function findCta(page: Page): Promise<CtaPick | null> {
  return page.evaluate(findCtaInPage);
}

/** A development store's password page. Only on our own host, only when we hold the password. Resolves true when it typed one. */
async function passStorefrontPassword(page: Page, deps: FunnelDeps): Promise<boolean> {
  const url = new URL(page.url());
  if (url.pathname !== '/password') return false;
  if (!deps.purchaseHost || url.hostname !== deps.purchaseHost || !deps.storefrontPassword) {
    throw new StopRun('store', 'the store is password-protected');
  }
  // The gate discards the URL it intercepted (the visitor lands on `/` afterwards) and with it
  // the click ID and UTMs the funnel carried. That is the dev store's behaviour, not the
  // funnel's, so after unlocking, the runner opens the URL that was gated — what a shopper on
  // a store without a password page would have seen.
  const gated = deps.collector.redirectedFromRaw;
  const field = page.locator('input[type="password"]').first();
  await field.fill(deps.storefrontPassword, { timeout: 5_000 });
  await Promise.all([
    page.waitForURL((u) => u.pathname !== '/password', {
      timeout: STEP_TIMEOUT_MS,
      waitUntil: 'load',
    }),
    field.press('Enter'),
  ]).catch((err: unknown) => {
    throw new StopRun('store', `storefront password was not accepted: ${message(err)}`);
  });
  if (gated && !gated.includes('/password')) {
    await page.goto(gated, { waitUntil: 'load', timeout: STEP_TIMEOUT_MS });
  }
  await settle(page);
  return true;
}

/**
 * Clicks "Pay now" and waits for the thank-you page. Shopify's checkout submits only once its
 * pending updates (address validation, shipping rates) have settled, and a click that lands a
 * moment early is silently ignored — observed on this project as a run that reached payment,
 * clicked, and never left the page. So: wait for the button to be enabled, click, allow a
 * bounded wait, and try again up to three times. If the page shows an error, that text is the
 * failure reason, not a bare timeout.
 */
async function payAndWait(page: Page): Promise<void> {
  const pay = page
    .locator('#checkout-pay-button, button:has-text("Pay now"), button:has-text("Complete order")')
    .first();
  const done = /thank[-_]you|\/orders\//;
  let lastError = 'no thank-you page after paying';
  for (let attempt = 1; attempt <= 3; attempt++) {
    await pay.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    if (!(await pay.isEnabled().catch(() => false))) {
      await page.waitForTimeout(1_500);
      continue;
    }
    await pay.click({ timeout: 5_000 });
    const arrived = await page
      .waitForURL(done, { timeout: 12_000, waitUntil: 'load' })
      .then(() => true)
      .catch(() => false);
    if (arrived) return;
    const errors = await page
      .locator('[role="alert"]:visible, [class*="error" i]:visible')
      .evaluateAll((els) =>
        els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean),
      )
      .catch(() => [] as string[]);
    if (errors.length > 0)
      lastError = `checkout reported: ${[...new Set(errors)].join(' | ').slice(0, 300)}`;
  }
  throw new Error(lastError);
}

const ADD_TO_CART =
  'form[action*="/cart/add"] button[type="submit"], button[name="add"], [data-add-to-cart]';

/** The add-to-cart button, if the product can actually be added (visible and not disabled/sold out). */
async function purchasableAddButton(page: Page): Promise<Locator | null> {
  const add = page.locator(ADD_TO_CART).first();
  if ((await add.count()) === 0) return null;
  if (!(await add.isVisible().catch(() => false))) return null;
  if (!(await add.isEnabled().catch(() => false))) return null;
  return add;
}

async function otherProductHrefs(page: Page, max: number): Promise<string[]> {
  const current = new URL(page.url()).pathname;
  const hrefs = await page
    .locator('a[href*="/products/"]')
    .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const href of hrefs) {
    const path = href.split('?')[0] ?? '';
    if (!path || path === current || seen.has(path)) continue;
    seen.add(path);
    out.push(href);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Shopify's checkout, by field name. The names have been stable across the one-page and
 * multi-step layouts; a field that is not on the page is skipped rather than failed, and any
 * "Continue" step is clicked through until the pay button appears.
 */
async function fillCheckout(page: Page, identity: FunnelIdentity): Promise<void> {
  const fill = async (selector: string, value: string): Promise<void> => {
    const loc = page.locator(selector).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      await loc.fill(value, { timeout: 5_000 });
    }
  };
  const select = async (selector: string, value: string): Promise<void> => {
    const loc = page.locator(selector).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      await loc.selectOption(value, { timeout: 5_000 }).catch(() => undefined);
    }
  };

  await fill('input[name="email"], #email', identity.email);
  await select('select[name="countryCode"]', 'US');
  await fill('input[name="firstName"]', identity.firstName);
  await fill('input[name="lastName"]', identity.lastName);
  // A real, deliverable address: Shopify validates it and a made-up street earns a "did you
  // mean" prompt that blocks payment. No phone: it is optional, and fictional numbers fail
  // validation.
  await fill('input[name="address1"]', identity.address1);
  await fill('input[name="city"]', identity.city);
  await select('select[name="zone"]', identity.zone);
  await fill('input[name="postalCode"]', identity.postalCode);
  // Let shipping rates for the address arrive before paying.
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);

  // Multi-step layouts: contact → shipping → payment. One-page layouts have no such buttons.
  for (let i = 0; i < 3; i++) {
    const cont = page
      .locator('button:has-text("Continue to shipping"), button:has-text("Continue to payment")')
      .first();
    if ((await cont.count()) === 0) break;
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined),
      cont.click({ timeout: 5_000 }),
    ]);
  }

  // Bogus Gateway card fields live in iframes named card-fields-<field>-<id>.
  const card = async (field: string, value: string): Promise<void> => {
    const frame = page.frameLocator(`iframe[name^="card-fields-${field}"]`).first();
    const input = frame.locator(`input[name="${field}"]`).first();
    await input.fill(value, { timeout: 10_000 });
  };
  await card('number', '1');
  await card('name', `${identity.firstName} ${identity.lastName}`);
  await card('expiry', '12/30');
  await card('verification_value', '123');
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
}
