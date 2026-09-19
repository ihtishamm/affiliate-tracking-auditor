import { parseEnv, webEnv, type WebEnv } from '@auditor/shared';

let cached: WebEnv | undefined;

/**
 * Validated once per server instance, on first use rather than at import: `next build`
 * imports route modules to read their config, and must not require production secrets.
 */
export function getEnv(): WebEnv {
  cached ??= parseEnv(webEnv);
  return cached;
}
