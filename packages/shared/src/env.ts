import { z } from 'zod';

// Environment validation (PROJECT_CONTEXT §7, §11). Each process parses its own schema exactly
// once at boot; no other file reads `process.env` directly. Later modules extend these schemas
// as they introduce secrets, so "which module needs which variable" stays greppable here.

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']).default('info');

const baseEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: logLevelSchema,
});

export const webEnv = baseEnv.extend({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // M2: where /go sends the shopper. Hostname only, e.g. auditor-demo.myshopify.com.
  SHOPIFY_STORE_DOMAIN: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, 'hostname only'),
  // M2: the Meta Pixel the advertorial fires. Not a secret (it is in every page's HTML), but it
  // is per-deployment configuration, so it lives with the rest of the config.
  META_PIXEL_ID: z.string().regex(/^\d{5,20}$/),
  // Injected by Vercel; surfaced by /api/health so a deploy can be matched to a commit.
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
});

export const workerEnv = baseEnv
  .extend({
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    // The health server's port. WORKER_PORT exists so a developer can move the worker in the
    // shared local .env without moving Next (which also honours PORT); Railway injects PORT.
    WORKER_PORT: z.coerce.number().int().positive().optional(),
    PORT: z.coerce.number().int().positive().optional(),
    RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
  })
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
