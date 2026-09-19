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
  // Injected by Vercel; surfaced by /api/health so a deploy can be matched to a commit.
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
});

export const workerEnv = baseEnv.extend({
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  // Railway injects PORT; the default is for local development.
  PORT: z.coerce.number().int().positive().default(8080),
  RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
});

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
