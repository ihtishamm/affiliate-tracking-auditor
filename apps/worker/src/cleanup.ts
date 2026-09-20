import type { Logger } from '@auditor/shared';

const INTERVAL_MS = 60 * 60 * 1000;

/**
 * The §8 TTL: once an hour, delete traces past `expires_at`. Runs once at boot too, so a
 * worker that was down for a day catches up on start. Everything else in the database is
 * append-only; this is the single scheduled DELETE.
 */
export function startTraceCleanup(
  deleteExpired: () => Promise<number>,
  log: Logger,
): { stop: () => void } {
  const tick = async (): Promise<void> => {
    try {
      const deleted = await deleteExpired();
      if (deleted > 0) log.info('expired traces deleted', { deleted });
    } catch (err) {
      log.warn('trace cleanup failed', { err });
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
