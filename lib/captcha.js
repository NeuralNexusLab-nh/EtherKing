'use strict';

const crypto = require('crypto');

const NEXA_VERIFY_URL = 'https://nexacaptcha.zone.id/api/v1/siteverify';
const CAPTCHA_TIMEOUT_MS = 10_000;
const GENERATION_MINIMUM = 10;
const GENERATION_MAXIMUM = 15;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

class HumanVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function captchaError(code, message) {
  return new HumanVerificationError(code, message);
}

function validateProof(proof) {
  const verificationId = typeof proof?.verificationId === 'string' ? proof.verificationId : '';
  const responseToken = typeof proof?.responseToken === 'string' ? proof.responseToken : '';
  if (!/^ver_[A-Za-z0-9_-]{22}$/.test(verificationId) || !/^[A-Za-z0-9_-]{32}$/.test(responseToken)) {
    throw captchaError('CAPTCHA_INVALID', 'Complete human verification and try again.');
  }
  return { verificationId, responseToken };
}

async function verifyCaptchaProof(proof, options = {}) {
  const payload = validateProof(proof);
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || CAPTCHA_TIMEOUT_MS);
  try {
    const response = await fetchImpl(NEXA_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      throw captchaError('CAPTCHA_UNAVAILABLE', 'Human verification is temporarily unavailable.');
    }
    const result = await response.json().catch(() => null);
    if (result?.success !== true) {
      throw captchaError('CAPTCHA_INVALID', 'Human verification expired or was already used. Try again.');
    }
    return { verifiedAt: result.verifiedAt || new Date().toISOString() };
  } catch (error) {
    if (error instanceof HumanVerificationError) throw error;
    throw captchaError('CAPTCHA_UNAVAILABLE', 'Human verification is temporarily unavailable.');
  } finally {
    clearTimeout(timeout);
  }
}

function nextGenerationThreshold(randomInt = crypto.randomInt) {
  return randomInt(GENERATION_MINIMUM, GENERATION_MAXIMUM + 1);
}

function generationRecord(data, userId, randomInt) {
  let record = data.captchaUsage.find((item) => item.userId === userId);
  if (!record) {
    record = {
      userId,
      generationCount: 0,
      threshold: nextGenerationThreshold(randomInt),
      updatedAt: new Date().toISOString()
    };
    data.captchaUsage.push(record);
  }
  if (!Number.isInteger(record.generationCount) || record.generationCount < 0) record.generationCount = 0;
  if (!Number.isInteger(record.threshold) || record.threshold < GENERATION_MINIMUM || record.threshold > GENERATION_MAXIMUM) {
    record.threshold = nextGenerationThreshold(randomInt);
  }
  return record;
}

function consumeGenerationAllowance(data, userId, options = {}) {
  const randomInt = options.randomInt || crypto.randomInt;
  const record = generationRecord(data, userId, randomInt);
  if (options.verified === true) {
    record.generationCount = 0;
    record.threshold = nextGenerationThreshold(randomInt);
    record.lastVerifiedAt = new Date(options.now || Date.now()).toISOString();
  }
  if (record.generationCount >= record.threshold) {
    throw captchaError('CAPTCHA_REQUIRED', 'Complete human verification to continue chatting.');
  }
  record.generationCount += 1;
  record.updatedAt = new Date(options.now || Date.now()).toISOString();
  return { remaining: record.threshold - record.generationCount, threshold: record.threshold };
}

function loginFailureRecord(data, bucketKey, now = Date.now()) {
  const staleCutoff = now - 24 * 60 * 60 * 1000;
  data.loginFailures = data.loginFailures.filter((item) => Date.parse(item.updatedAt) > staleCutoff);
  let record = data.loginFailures.find((item) => item.bucketKey === bucketKey);
  if (!record) {
    record = {
      bucketKey,
      failureCount: 0,
      windowStartedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString()
    };
    data.loginFailures.push(record);
  }
  if (Date.parse(record.windowStartedAt) <= now - LOGIN_FAILURE_WINDOW_MS) {
    record.failureCount = 0;
    record.windowStartedAt = new Date(now).toISOString();
  }
  return record;
}

function loginCaptchaRequired(data, bucketKey, now = Date.now()) {
  return loginFailureRecord(data, bucketKey, now).failureCount >= 3;
}

function recordLoginFailure(data, bucketKey, now = Date.now()) {
  const record = loginFailureRecord(data, bucketKey, now);
  record.failureCount += 1;
  record.updatedAt = new Date(now).toISOString();
  return record.failureCount;
}

function clearLoginFailures(data, bucketKey) {
  data.loginFailures = data.loginFailures.filter((item) => item.bucketKey !== bucketKey);
}

module.exports = {
  CAPTCHA_TIMEOUT_MS,
  GENERATION_MAXIMUM,
  GENERATION_MINIMUM,
  HumanVerificationError,
  LOGIN_FAILURE_WINDOW_MS,
  NEXA_VERIFY_URL,
  clearLoginFailures,
  consumeGenerationAllowance,
  loginCaptchaRequired,
  recordLoginFailure,
  validateProof,
  verifyCaptchaProof
};
