import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof createDb>;

/**
 * One connection factory for both runtimes. A Vercel function instance keeps a single
 * connection against Neon's pooled endpoint; the long-lived worker may ask for a few more.
 */
export function createDb(url: string, opts: { max?: number } = {}) {
  const client = postgres(url, {
    max: opts.max ?? 1,
    // Neon's pooled endpoint is PgBouncer in transaction mode: a named prepared statement may
    // be sent to a different backend than the one that prepared it. Unnamed statements are
    // always safe, and the throughput cost is irrelevant at this project's volume.
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return drizzle(client, { schema });
}

/** Round-trips a trivial query; throws if the database is unreachable. */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
