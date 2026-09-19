import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import tseslint from 'typescript-eslint';

// ESLint is pinned to 9.x although 10 is out: eslint-config-next 16 bundles eslint-plugin-react,
// which still calls `context.getFilename()` (removed in ESLint 10) and crashes on every .tsx file.
export default defineConfig([
  globalIgnores([
    '**/node_modules/',
    '**/.next/',
    '**/dist/',
    '**/next-env.d.ts',
    'packages/db/drizzle/',
  ]),
  {
    files: ['**/*.{ts,tsx,mts,mjs}'],
    extends: [tseslint.configs.recommended],
    rules: {
      // PROJECT_CONTEXT §11: no `any`. Already an error in `recommended`; stated here so it is
      // visible to anyone reading this file rather than buried in a preset.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Next-specific rules only apply to the web app; the plugin needs to know where it lives.
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [nextVitals, nextTs],
    settings: { next: { rootDir: 'apps/web/' } },
  },
  // Must be last: switches off every rule that would fight Prettier over formatting.
  prettier,
]);
