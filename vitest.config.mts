import { defineConfig } from 'vitest/config';

// One runner for the whole monorepo. Tests live only where PROJECT_CONTEXT §4 allows them:
// the check engine (packages/checks), the HMAC and PII logic (packages/shared), and the
// postback/webhook decision cores (apps/web/lib).
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/web/lib/**/*.test.ts'],
    passWithNoTests: true,
  },
});
