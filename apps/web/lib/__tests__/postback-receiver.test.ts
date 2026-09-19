import { describe, expect, it } from 'vitest';
import { createLogger, signHex, type PostbackPayload } from '@auditor/shared';
import { receivePostback } from '../postback-receiver.ts';

const secret = 'unit-test-postback-key-not-a-real-secret';
const log = createLogger({ service: 'test', level: 'error', write: () => {} });

const payload: PostbackPayload = {
  postback_id: 'pb-5592397545769',
  click_id: 'abc123',
  order_id: '5592397545769',
  status: 'approved',
  amount: 1025,
  currency: 'USD',
  occurred_at: '2026-09-19T13:35:00.000Z',
};
const body = JSON.stringify(payload);

/** An in-memory stand-in for the unique index: first insert of an id wins, the rest lose. */
function memoryStore() {
  const seen = new Set<string>();
  const inserted: PostbackPayload[] = [];
  return {
    inserted,
    insert: async (p: PostbackPayload) => {
      if (seen.has(p.postback_id)) return false;
      seen.add(p.postback_id);
      inserted.push(p);
      return true;
    },
  };
}

describe('receivePostback', () => {
  it('accepts a correctly signed postback and stores it once', async () => {
    const store = memoryStore();
    const out = await receivePostback(body, signHex(secret, body), {
      secret,
      insert: store.insert,
      log,
    });
    expect(out).toEqual({
      status: 200,
      body: { status: 'accepted', postback_id: payload.postback_id },
    });
    expect(store.inserted).toHaveLength(1);
  });

  it('REPLAY: the identical request again is 200 duplicate and is not stored twice', async () => {
    const store = memoryStore();
    const signature = signHex(secret, body);
    await receivePostback(body, signature, { secret, insert: store.insert, log });
    const replay = await receivePostback(body, signature, { secret, insert: store.insert, log });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ status: 'duplicate', postback_id: payload.postback_id });
    expect(store.inserted).toHaveLength(1);
  });

  it('TAMPER: a body altered after signing is 401 and nothing is stored', async () => {
    const store = memoryStore();
    const signature = signHex(secret, body);
    const tampered = body.replace('"amount":1025', '"amount":9999');
    const out = await receivePostback(tampered, signature, { secret, insert: store.insert, log });
    expect(out).toEqual({ status: 401, body: { error: 'invalid_signature' } });
    expect(store.inserted).toHaveLength(0);
  });

  it('TAMPER: a valid body with a forged or missing signature is 401', async () => {
    const store = memoryStore();
    for (const sig of [null, '', 'deadbeef', signHex('wrong-secret', body)]) {
      const out = await receivePostback(body, sig, { secret, insert: store.insert, log });
      expect(out.status).toBe(401);
    }
    expect(store.inserted).toHaveLength(0);
  });

  it('a signed body that fails the schema is 400 with the reasons, not stored', async () => {
    const store = memoryStore();
    const bad = JSON.stringify({ ...payload, currency: 'usd', amount: -1 });
    const out = await receivePostback(bad, signHex(secret, bad), {
      secret,
      insert: store.insert,
      log,
    });
    expect(out.status).toBe(400);
    if (out.status === 400) {
      expect(out.body.issues.join('\n')).toMatch(/currency/);
      expect(out.body.issues.join('\n')).toMatch(/amount/);
    }
    expect(store.inserted).toHaveLength(0);
  });

  it('a signed body that is not JSON is 400', async () => {
    const store = memoryStore();
    const out = await receivePostback('not json', signHex(secret, 'not json'), {
      secret,
      insert: store.insert,
      log,
    });
    expect(out.status).toBe(400);
  });

  it('postback_500 sabotage: 500 before anything is stored, on every attempt', async () => {
    const store = memoryStore();
    const broken = JSON.stringify({ ...payload, __break: 'postback_500' });
    for (let i = 0; i < 3; i++) {
      const out = await receivePostback(broken, signHex(secret, broken), {
        secret,
        insert: store.insert,
        log,
      });
      expect(out.status).toBe(500);
    }
    expect(store.inserted).toHaveLength(0);
  });
});
