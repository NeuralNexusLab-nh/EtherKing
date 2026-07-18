'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

async function withServer(run) {
  const pool = { query: async () => ({ rowCount: 1, rows: [{ '?column?': 1 }] }) };
  const app = createApp(pool);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('serves the account page with strict browser security headers', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(body, /Welcome back/);
  });
});

test('blocks chat APIs and the app page when signed out', async () => {
  await withServer(async (baseUrl) => {
    const apiResponse = await fetch(`${baseUrl}/api/chats`);
    assert.equal(apiResponse.status, 401);
    const appResponse = await fetch(`${baseUrl}/app`, { redirect: 'manual' });
    assert.equal(appResponse.status, 302);
    assert.equal(appResponse.headers.get('location'), '/');
  });
});

test('blocks cross-site mutations before processing credentials', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
      body: JSON.stringify({ email: 'person@example.com', password: 'password-1234' })
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Origin not allowed.' });
  });
});

test('rejects malformed JSON without leaking an internal error', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json'
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid JSON body.' });
  });
});

