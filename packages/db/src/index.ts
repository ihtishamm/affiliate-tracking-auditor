export { createDb, pingDb } from './client.ts';
export type { Db } from './client.ts';
export * as schema from './schema.ts';
// Query operators, re-exported so apps depend on this package alone and not on drizzle-orm
// directly: the ORM is a detail of the db package, not of the web app or the worker.
export { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
