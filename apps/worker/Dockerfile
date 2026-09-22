# Worker image. Build context is the repository root (see railway.json), because the worker
# depends on workspace packages.
#
# The base image ships Node 24 plus Chromium/Firefox/WebKit builds that match Playwright 1.63.0
# exactly. The `playwright` version in apps/worker/package.json MUST move in lockstep with this
# tag, or launch fails with "Executable doesn't exist".
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# pnpm via npm rather than corepack: corepack is deprecated and absent from newer Node builds.
RUN npm install --global pnpm@12.4.2

WORKDIR /app

# Manifests first, so the dependency layer is cached until a package.json changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/checks/package.json packages/checks/
# `@auditor/worker...` = the worker and everything it depends on inside the workspace.
RUN pnpm install --frozen-lockfile --filter "@auditor/worker..."

# No build step: Node 24 strips TypeScript types at load time. `tsc` runs in CI as a type
# checker only, so the code that was type-checked is byte-for-byte the code that runs.
COPY tsconfig.base.json ./
COPY apps/worker apps/worker
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/checks packages/checks

# Never run Chromium as root.
USER pwuser
ENV NODE_ENV=production
CMD ["node", "apps/worker/src/index.ts"]
