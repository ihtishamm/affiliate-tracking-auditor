import { createDb, type Db } from '@auditor/db';
import { getEnv } from '@/lib/env.ts';

let db: Db | undefined;

/** Created lazily for the same reason as `getEnv()`: builds must not need DATABASE_URL. */
export function getDb(): Db {
  db ??= createDb(getEnv().DATABASE_URL);
  return db;
}
