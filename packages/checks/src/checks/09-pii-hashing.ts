import type { Check } from '../check.ts';
import { fail, inconclusive, pass } from '../check.ts';

// 9. PII hashing — identity parameters sent to the pixel (`ud[em]`, `ud[ph]`, …) are SHA-256
// hashes of normalised values (trimmed, lower-cased email; digits-only phone), never
// plaintext. Plaintext is a privacy incident; a hash of the un-normalised value is silently
// useless, because Meta hashes its own copy after normalising and the two never match.
//
// Evidence: the redactor's verdict on every PII-classified pixel parameter
// (`looksHashed`, `hashAlgoGuess`, `normalised` — judged against the identity the runner
// typed) plus the sender's `pii_hashed` flag on the CAPI attempt. The values themselves were
// never stored, so this check can only ever see those verdicts.
export const piiHashing: Check = {
  id: 'pii_hashing',
  number: 9,
  title: 'PII hashing',
  run(ctx) {
    type Finding = { key: string; event: string; kind: 'plaintext' | 'weak_hash' | 'unnormalised' };
    const findings: Finding[] = [];
    let inspected = 0;
    for (const h of ctx.hits) {
      for (const [key, p] of Object.entries(h.params)) {
        if (p.kind !== 'pii') continue;
        inspected++;
        if (!p.looksHashed) findings.push({ key, event: h.event, kind: 'plaintext' });
        else if (p.hashAlgoGuess !== 'sha256')
          findings.push({ key, event: h.event, kind: 'weak_hash' });
        else if (p.normalised === false)
          findings.push({ key, event: h.event, kind: 'unnormalised' });
      }
    }
    const capiUnhashed =
      ctx.server?.conversionAttempts.some((a) => a.kind === 'capi' && a.piiHashed === false) ??
      false;

    if (inspected === 0 && !capiUnhashed) {
      return inconclusive({
        observed: 'no identity parameters on any pixel event',
        expected: 'hashed em/ph on the Purchase event',
        reason: ctx.reached('thank_you')
          ? 'the pixel sends no advanced-matching parameters'
          : `no purchase, so no identity was sent: ${ctx.stoppedAt()}`,
        fixHint: '',
      });
    }
    if (findings.length > 0 || capiUnhashed) {
      const parts = findings.map(
        (f) =>
          `${f.key} on ${f.event}: ${f.kind === 'plaintext' ? 'plaintext' : f.kind === 'weak_hash' ? 'not SHA-256' : 'hashed without normalising'}`,
      );
      if (capiUnhashed) parts.push('server-side Purchase sent user_data unhashed');
      return fail({
        observed: parts.join('; '),
        expected: 'every identity parameter a SHA-256 of the trimmed, lower-cased value',
        reason:
          findings.some((f) => f.kind === 'plaintext') || capiUnhashed
            ? 'customer data left the browser or server in the clear'
            : 'the hashes cannot match what Meta computes',
        fixHint:
          'Normalise (trim, lower-case; digits-only for phone) and SHA-256 every identity value before sending; never add customer fields as custom parameters.',
      });
    }
    const normalisedConfirmed = ctx.hits.some((h) =>
      Object.values(h.params).some((p) => p.kind === 'pii' && p.normalised === true),
    );
    return pass({
      observed: `${inspected} identity parameter(s), all SHA-256${normalisedConfirmed ? ', normalised (matched the hash of the typed email)' : ''}`,
      expected: 'hashed and normalised identity parameters',
      reason: 'no plaintext left the browser and the hashes are ones Meta can match',
    });
  },
};
