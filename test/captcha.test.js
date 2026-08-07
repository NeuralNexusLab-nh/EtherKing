'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NEXA_VERIFY_URL,
  consumeGenerationAllowance,
  verifyCaptchaProof
} = require('../lib/captcha');

const proof = {
  verificationId: 'ver_abcdefghijklmnopqrstuv',
  responseToken: 'abcdefghijklmnopqrstuvwxyzABCDEF'
};

test('verifies a NexaCAPTCHA proof with the documented server endpoint', async () => {
  let request;
  const result = await verifyCaptchaProof(proof, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ success: true, verifiedAt: '2026-08-07T12:30:00.000Z' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  assert.equal(request.url, NEXA_VERIFY_URL);
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), proof);
  assert.equal(result.verifiedAt, '2026-08-07T12:30:00.000Z');
});

test('rejects malformed and expired NexaCAPTCHA proofs', async () => {
  await assert.rejects(verifyCaptchaProof({}, { fetchImpl: async () => { throw new Error('must not run'); } }), { code: 'CAPTCHA_INVALID' });
  await assert.rejects(verifyCaptchaProof(proof, {
    fetchImpl: async () => new Response(JSON.stringify({ success: false, errorCode: 'invalid-or-expired-verification' }), { status: 200 })
  }), { code: 'CAPTCHA_INVALID' });
});

test('requires chat verification after every 10 generations', () => {
  const data = { captchaUsage: [] };
  for (let count = 0; count < 10; count += 1) {
    consumeGenerationAllowance(data, 'user-a');
  }
  assert.throws(() => consumeGenerationAllowance(data, 'user-a'), { code: 'CAPTCHA_REQUIRED' });
  const reset = consumeGenerationAllowance(data, 'user-a', { verified: true });
  assert.equal(reset.threshold, 10);
  assert.equal(reset.remaining, 9);
});
