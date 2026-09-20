import { z } from 'zod';

// Environment validation (PROJECT_CONTEXT §7, §11). Each process parses its own schema exactly
// once at boot; no other file reads `process.env` directly. Later modules extend these schemas
// as they introduce secrets, so "which module needs which variable" stays greppable here.

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']).default('info');

const baseEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: logLevelSchema,
  // M4: lets the SSRF guard admit localhost and private addresses so a developer can audit the
  // funnel running on their own machine. Refused in production below: there it would turn
  // the tool into a proxy into the hosting network.
  ALLOW_PRIVATE_TARGETS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const refusePrivateInProduction = (
  env: { NODE_ENV: string; ALLOW_PRIVATE_TARGETS: boolean },
  ctx: z.RefinementCtx,
): void => {
  if (env.NODE_ENV === 'production' && env.ALLOW_PRIVATE_TARGETS) {
    ctx.addIssue({
      code: 'custom',
      path: ['ALLOW_PRIVATE_TARGETS'],
      message: 'must not be true in production',
    });
  }
};

export const webEnv = baseEnv
  .extend({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // M2: where /go sends the shopper. Hostname only, e.g. auditor-demo.myshopify.com.
    SHOPIFY_STORE_DOMAIN: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, 'hostname only'),
    // M2: the Meta Pixel the advertorial fires. Not a secret (it is in every page's HTML), but it
    // is per-deployment configuration, so it lives with the rest of the config.
    META_PIXEL_ID: z.string().regex(/^\d{5,20}$/),
    // M3: verifies POST /api/postback. Also used by our own conversion sender to sign what it
    // sends there. 32+ chars: `openssl rand -hex 32`.
    POSTBACK_HMAC_SECRET: z.string().min(32),
    // M3: the signing secret Shopify shows when a webhook is created in Settings → Notifications.
    SHOPIFY_WEBHOOK_SECRET: z.string().min(16),
    // M3: Conversions API system-user token from Events Manager → dataset → Settings.
    META_CAPI_TOKEN: z.string().min(16),
    // M3, optional: Events Manager → Test events code, so server events appear in that tool.
    META_TEST_EVENT_CODE: z.string().optional(),
    // M4: BullMQ producer and per-IP rate-limit counters. On Vercel this is the Railway Redis
    // TCP-proxy URL (password, no TLS); the worker keeps the private-network URL.
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    // Injected by Vercel; surfaced by /api/health so a deploy can be matched to a commit.
    VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  })
  .superRefine(refusePrivateInProduction);

export const workerEnv = baseEnv
  .extend({
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    // M4: the worker writes run_events and run_traces. Same pooled Neon URL as the web app.
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // M4, optional: a development store's password page cannot be removed; the runner types
    // this when — and only when — it meets that page on the job's `purchaseHost`.
    SHOPIFY_STOREFRONT_PASSWORD: z.string().optional(),
    // The health server's port. WORKER_PORT exists so a developer can move the worker in the
    // shared local .env without moving Next (which also honours PORT); Railway injects PORT.
    WORKER_PORT: z.coerce.number().int().positive().optional(),
    PORT: z.coerce.number().int().positive().optional(),
    RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
  })
  .superRefine(refusePrivateInProduction)
  .transform((env) => ({ ...env, PORT: env.WORKER_PORT ?? env.PORT ?? 8080 }));

export type WebEnv = z.infer<typeof webEnv>;
export type WorkerEnv = z.infer<typeof workerEnv>;

/**
 * Parses `source` against `schema`, throwing a single error that lists every problem at once.
 * Callers decide how to fail (the worker exits; the web app surfaces it on first request).
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues.map(
    (issue) => `  ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
  );
  throw new Error(`Invalid environment:\n${problems.join('\n')}`);
}
