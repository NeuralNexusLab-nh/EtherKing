'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length >= 5 && email.length <= 254 && EMAIL_PATTERN.test(email);
}

function validatePassword(value) {
  if (typeof value !== 'string') return 'Password is required.';
  if (value.length < PASSWORD_MIN_LENGTH) return `Password must contain at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (value.length > PASSWORD_MAX_LENGTH) return `Password must contain no more than ${PASSWORD_MAX_LENGTH} characters.`;
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) return 'Password must contain at least one letter and one number.';
  return null;
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 60);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const cost = 32768;
  const blockSize = 8;
  const parallelization = 1;
  const hash = await scryptAsync(password, salt, 64, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 64 * 1024 * 1024
  });
  return ['scrypt', cost, blockSize, parallelization, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

async function verifyPassword(password, storedValue) {
  try {
    const [algorithm, costValue, blockValue, parallelValue, saltValue, hashValue] = String(storedValue).split('$');
    if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;
    const expected = Buffer.from(hashValue, 'base64url');
    const actual = await scryptAsync(password, Buffer.from(saltValue, 'base64url'), expected.length, {
      N: Number(costValue),
      r: Number(blockValue),
      p: Number(parallelValue),
      maxmem: 64 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
    return cookies;
  }, {});
}

function safeEqual(valueA, valueB) {
  const a = Buffer.from(String(valueA || ''));
  const b = Buffer.from(String(valueB || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function compactTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title) return 'New chat';
  return title.length <= 56 ? title : `${title.slice(0, 53).trimEnd()}...`;
}

function isAllowedOrigin(origin, expectedOrigin) {
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}

module.exports = {
  PASSWORD_MAX_LENGTH,
  compactTitle,
  hashPassword,
  hashToken,
  isAllowedOrigin,
  isValidEmail,
  normalizeDisplayName,
  normalizeEmail,
  parseCookies,
  randomToken,
  safeEqual,
  todayUtc,
  validatePassword,
  verifyPassword
};

