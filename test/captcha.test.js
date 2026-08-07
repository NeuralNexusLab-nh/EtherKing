'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LOGIN_FAILURE_WINDOW_MS,
  NEXA_VERIFY_URL,
  clearLoginFailures,
  consumeGenerationAllowance,
  loginCaptchaRequired,
  recordLoginFailure,
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

test('requires chat verification after a server-selected 10 to 15 generation interval', () => {
  const data = { captchaUsage: [] };
  const fixedThreshold = () => 10;
  for (let count = 0; count < 10; count += 1) {
    consumeGenerationAllowance(data, 'user-a', { randomInt: fixedThreshold });
  }
  assert.throws(() => consumeGenerationAllowance(data, 'user-a', { randomInt: fixedThreshold }), { code: 'CAPTCHA_REQUIRED' });
  const reset = consumeGenerationAllowance(data, 'user-a', { randomInt: fixedThreshold, verified: true });
  assert.equal(reset.threshold, 10);
  assert.equal(reset.remaining, 9);
});

test('requires login verification after three failures in a rolling window', () => {
  const data = { loginFailures: [] };
  const now = Date.UTC(2026, 7, 7, 12, 0, 0);
  assert.equal(loginCaptchaRequired(data, 'bucket', now), false);
  recordLoginFailure(data, 'bucket', now);
  recordLoginFailure(data, 'bucket', now);
  recordLoginFailure(data, 'bucket', now);
  assert.equal(loginCaptchaRequired(data, 'bucket', now), true);
  assert.equal(loginCaptchaRequired(data, 'bucket', now + LOGIN_FAILURE_WINDOW_MS + 1), false);
  recordLoginFailure(data, 'bucket', now + LOGIN_FAILURE_WINDOW_MS + 1);
  clearLoginFailures(data, 'bucket');
  assert.equal(loginCaptchaRequired(data, 'bucket', now + LOGIN_FAILURE_WINDOW_MS + 1), false);
});
