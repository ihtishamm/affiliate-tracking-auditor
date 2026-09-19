import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages export TypeScript source rather than compiled JavaScript, so Next
  // compiles them alongside the app. The worker consumes the same source directly under Node.
  transpilePackages: ['@auditor/shared', '@auditor/db', '@auditor/checks'],
  // Next 16 otherwise writes AGENTS.md and CLAUDE.md into this directory on `next dev`.
  // PROJECT_CONTEXT.md is the single source of truth for this repo; no generated guidance files.
  agentRules: false,
};

export default nextConfig;
