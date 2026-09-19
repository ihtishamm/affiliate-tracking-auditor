import { defineConfig } from 'drizzle-kit';

// Schema changes become SQL files in ./drizzle via `pnpm db:generate`, are committed, and are
// applied with `pnpm db:migrate` as an explicit step: never at app boot (serverless instances
// would race each other) and never with `drizzle-kit push` (no reviewable history). This is
// how PROJECT_CONTEXT §11 "append-only, no destructive migrations" is enforced in practice:
// every migration is a diff someone can read before it runs.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // `generate` never connects. `migrate` needs a URL: the root `pnpm db:migrate` script loads
    // .env; against production, pass DATABASE_URL explicitly on the command line.
    url: process.env.DATABASE_URL ?? 'postgresql://auditor:auditor@localhost:5433/auditor',
  },
  strict: true,
  verbose: true,
});
