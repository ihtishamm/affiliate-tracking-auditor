import { defineConfig } from 'vitest/config';

// One runner for the whole monorepo. Tests live only where PROJECT_CONTEXT §4 allows them:
// the check engine (packages/checks) and the HMAC/idempotency logic (packages/shared).
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    passWithNoTests: true,
  },
});
