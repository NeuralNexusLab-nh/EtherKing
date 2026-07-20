'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { FileStore } = require('../lib/storage');
const { createApp, reserveQuota } = require('../server');

async function withServer(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etherking-http-'));
  const store = await new FileStore(path.join(directory, 'store.json')).init();
  const app = createApp(store);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
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

test('registers a user and persists an authenticated chat', async () => {
  await withServer(async (baseUrl) => {
    const registration = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ displayName: 'Ada User', email: 'ada@example.com', password: 'correct-horse-123' })
    });
    assert.equal(registration.status, 201);
    const setCookies = registration.headers.getSetCookie();
    const cookieHeader = setCookies.map((value) => value.split(';')[0]).join('; ');
    const csrfCookie = setCookies.find((value) => value.startsWith('etherking_csrf='));
    const csrfToken = decodeURIComponent(csrfCookie.split(';')[0].split('=').slice(1).join('='));

    const created = await fetch(`${baseUrl}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, Origin: baseUrl, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ title: 'Persist this chat', model: 'gpt-5.4-mini' })
    });
    assert.equal(created.status, 201);
    const chat = (await created.json()).chat;

    const fetched = await fetch(`${baseUrl}/api/chats/${chat.id}`, { headers: { Cookie: cookieHeader } });
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json()).chat.title, 'Persist this chat');
  });
});

test('keeps daily model quotas separate per user', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etherking-quota-'));
  try {
    const store = await new FileStore(path.join(directory, 'store.json')).init();
    assert.equal(await reserveQuota(store, 'user-a', 'D', 1), 1);
    assert.equal(await reserveQuota(store, 'user-a', 'D', 1), null);
    assert.equal(await reserveQuota(store, 'user-b', 'D', 1), 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

