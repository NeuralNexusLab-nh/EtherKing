'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compactTitle,
  hashPassword,
  hashToken,
  isAllowedOrigin,
  isValidEmail,
  normalizeDisplayName,
  normalizeEmail,
  parseCookies,
  safeEqual,
  validatePassword,
  verifyPassword
} = require('../lib/security');

test('normalizes and validates account fields', () => {
  assert.equal(normalizeEmail('  Person@Example.COM '), 'person@example.com');
  assert.equal(isValidEmail('person@example.com'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(normalizeDisplayName('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.match(validatePassword('short'), /at least/);
  assert.match(validatePassword('onlyletterslong'), /letter and one number/);
  assert.equal(validatePassword('strong-pass-123'), null);
});

test('hashes passwords with a unique salt and verifies safely', async () => {
  const password = 'correct horse 123';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('wrong password 123', first), false);
  assert.equal(await verifyPassword(password, 'invalid'), false);
});

test('handles tokens, cookies, and constant-time comparisons', () => {
  assert.equal(hashToken('token').length, 64);
  assert.deepEqual(parseCookies('a=one; encoded=hello%20world'), { a: 'one', encoded: 'hello world' });
  assert.equal(safeEqual('same', 'same'), true);
  assert.equal(safeEqual('same', 'different'), false);
});

test('allows only the configured origin', () => {
  assert.equal(isAllowedOrigin('https://chat.example.com', 'https://chat.example.com/app'), true);
  assert.equal(isAllowedOrigin('https://evil.example', 'https://chat.example.com'), false);
  assert.equal(isAllowedOrigin('', 'https://chat.example.com'), true);
});

test('creates compact, predictable chat titles', () => {
  assert.equal(compactTitle('  Hello   world  '), 'Hello world');
  assert.equal(compactTitle(''), 'New chat');
  assert.ok(compactTitle('x'.repeat(100)).length <= 56);
});

