import { createLogger, logLevelSchema } from '@auditor/shared';

// LOG_LEVEL alone is read eagerly: it has a default, so a missing value can never fail a build.
export const log = createLogger({
  service: 'web',
  level: logLevelSchema.parse(process.env.LOG_LEVEL),
});
