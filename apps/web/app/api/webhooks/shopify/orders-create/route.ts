import { NextResponse, after } from 'next/server';
import { getDb } from '@/lib/db.ts';
import { getEnv } from '@/lib/env.ts';
import { log } from '@/lib/log.ts';
import { sendConversions } from '@/lib/conversion-sender.ts';
import {
  SHOPIFY_EVENT_ID_HEADER,
  SHOPIFY_HMAC_HEADER,
  SHOPIFY_SHOP_DOMAIN_HEADER,
  SHOPIFY_TOPIC_HEADER,
  SHOPIFY_WEBHOOK_ID_HEADER,
  receiveShopifyOrder,
} from '@/lib/shopify-webhook.ts';
import { insertShopifyWebhookEvent, recordConversionAttempt } from '@/lib/store.ts';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/shopify/orders-create — verifies, deduplicates and records the delivery,
 * answers Shopify at once, and only then (via `after`) acts as the conversion sender.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const env = getEnv();
  const db = getDb();
  const rawBody = await request.text();

  const outcome = await receiveShopifyOrder(
    rawBody,
    {
      hmac: request.headers.get(SHOPIFY_HMAC_HEADER),
      eventId: request.headers.get(SHOPIFY_EVENT_ID_HEADER),
      webhookId: request.headers.get(SHOPIFY_WEBHOOK_ID_HEADER),
      topic: request.headers.get(SHOPIFY_TOPIC_HEADER),
      shopDomain: request.headers.get(SHOPIFY_SHOP_DOMAIN_HEADER),
    },
    { secret: env.SHOPIFY_WEBHOOK_SECRET, insert: insertShopifyWebhookEvent(db), log },
  );

  if (outcome.status === 200 && outcome.order) {
    const order = outcome.order;
    // Runs after the response is sent; Vercel keeps the function alive for it. A duplicate
    // delivery never reaches here, which is what makes the webhook safe to retry.
    after(() =>
      sendConversions(order, {
        fetch,
        record: recordConversionAttempt(db),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log,
        meta: {
          pixelId: env.META_PIXEL_ID,
          capiToken: env.META_CAPI_TOKEN,
          testEventCode: env.META_TEST_EVENT_CODE,
        },
        postback: {
          url: new URL('/api/postback', request.url).toString(),
          secret: env.POSTBACK_HMAC_SECRET,
        },
        storeDomain: env.SHOPIFY_STORE_DOMAIN,
      }).catch((err: unknown) => log.error('conversion sender failed', { err })),
    );
  }

  return NextResponse.json(outcome.body, { status: outcome.status });
}
