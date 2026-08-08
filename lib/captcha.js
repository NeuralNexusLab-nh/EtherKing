'use strict';

const NEXA_VERIFY_URL = 'https://nexacaptcha.zone.id/api/siteverify';
const CAPTCHA_TIMEOUT_MS = 10_000;
const GENERATION_INTERVAL = 10;

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
  if (!/^ver_[A-Za-z0-9_-]{12}$/.test(verificationId) || !/^[A-Za-z0-9_-]{64}$/.test(responseToken)) {
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

function generationRecord(data, userId) {
  let record = data.captchaUsage.find((item) => item.userId === userId);
  if (!record) {
    record = {
      userId,
      generationCount: 0,
      threshold: GENERATION_INTERVAL,
      updatedAt: new Date().toISOString()
    };
    data.captchaUsage.push(record);
  }
  if (!Number.isInteger(record.generationCount) || record.generationCount < 0) record.generationCount = 0;
  if (record.threshold !== GENERATION_INTERVAL) record.threshold = GENERATION_INTERVAL;
  return record;
}

function consumeGenerationAllowance(data, userId, options = {}) {
  const record = generationRecord(data, userId);
  if (options.verified === true) {
    record.generationCount = 0;
    record.threshold = GENERATION_INTERVAL;
    record.lastVerifiedAt = new Date(options.now || Date.now()).toISOString();
  }
  if (record.generationCount >= record.threshold) {
    throw captchaError('CAPTCHA_REQUIRED', 'Complete human verification to continue chatting.');
  }
  record.generationCount += 1;
  record.updatedAt = new Date(options.now || Date.now()).toISOString();
  return { remaining: record.threshold - record.generationCount, threshold: record.threshold };
}

module.exports = {
  CAPTCHA_TIMEOUT_MS,
  GENERATION_INTERVAL,
  HumanVerificationError,
  NEXA_VERIFY_URL,
  consumeGenerationAllowance,
  validateProof,
  verifyCaptchaProof
};
