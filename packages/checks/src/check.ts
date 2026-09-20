import type { CheckContext } from './context.ts';
import type { CheckId, CheckResult, CheckStatus } from './types.ts';

/** What each check file exports. `run` may throw; the engine turns that into `inconclusive`. */
export interface Check {
  id: CheckId;
  number: number;
  title: string;
  run(ctx: CheckContext): Verdict;
}

export type Verdict = Pick<CheckResult, 'status' | 'observed' | 'expected' | 'reason' | 'fixHint'>;

export function verdict(status: CheckStatus, fields: Omit<Verdict, 'status'>): Verdict {
  return { status, ...fields };
}

export const pass = (fields: Omit<Verdict, 'status' | 'fixHint'>): Verdict =>
  verdict('pass', { ...fields, fixHint: '' });
export const fail = (fields: Omit<Verdict, 'status'>): Verdict => verdict('fail', fields);
export const inconclusive = (fields: Omit<Verdict, 'status'>): Verdict =>
  verdict('inconclusive', fields);
