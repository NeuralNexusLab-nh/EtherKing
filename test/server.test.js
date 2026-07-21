'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { FileStore } = require('../lib/storage');
const { createApp } = require('../server');
const { chargeQuota, getQuotaUsage, QUOTA_WINDOWS, reserveQuota } = require('../lib/quota');

async function withServer(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etherking-http-'));
  const store = await new FileStore(path.join(directory, 'store.json')).init();
  const app = createApp(store);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('serves shared chats at the same read-only chat URL without authentication', async () => {
  await withServer(async (baseUrl, store) => {
    const userId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    await store.mutate((data) => {
      data.chats.push({ id: chatId, userId, title: 'Shared chat', model: 'gpt-5.4-mini', isShared: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      data.messages.push({ id: crypto.randomUUID(), chatId, userId, role: 'assistant', content: 'Public answer', createdAt: new Date().toISOString() });
    });
    const apiResponse = await fetch(`${baseUrl}/api/shared/chats/${chatId}`);
    assert.equal(apiResponse.status, 200);
    const payload = await apiResponse.json();
    assert.equal(payload.readOnly, true);
    assert.equal(payload.messages[0].content, 'Public answer');
    const pageResponse = await fetch(`${baseUrl}/chats/${chatId}`, { redirect: 'manual' });
    assert.equal(pageResponse.status, 200);
  });
});

test('serves the account page with strict browser security headers', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(body, /Welcome back/);
  });
});

test('disables browser caching for frontend assets', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/assets/auth.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('etag'), null);
    assert.equal(response.headers.get('last-modified'), null);
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
    assert.equal((await fetched.json()).chat.title, 'New chat');
  });
});

test('shares rolling dual-window point quotas across plans per user and clamps display at zero', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etherking-quota-'));
  try {
    const store = await new FileStore(path.join(directory, 'store.json')).init();
    const now = Date.UTC(2026, 6, 20, 0, 0, 0);
    assert.notEqual(await reserveQuota(store, 'user-a', 'pro', undefined, now), null);
    await store.mutate((data) => chargeQuota(data, 'user-a', QUOTA_WINDOWS.fiveHour.capacity, now));
    assert.equal(await reserveQuota(store, 'user-a', 'plus', undefined, now), null);
    assert.notEqual(await reserveQuota(store, 'user-b', 'basic', undefined, now), null);
    const usage = await getQuotaUsage(store, 'user-a', now);
    assert.equal(usage.windows.fiveHour.remainingPercent, 0);
    assert.equal(usage.windows.weekly.remainingPercent, 87.5);

    const resetUsage = await getQuotaUsage(store, 'user-a', now + (5 * 60 * 60 * 1000) + 1);
    assert.equal(resetUsage.windows.fiveHour.remainingPercent, 100);
    assert.equal(resetUsage.windows.weekly.remainingPercent, 87.5);

    await store.mutate((data) => {
      data.quotaUsage.push({ userId: 'legacy-user', window: 'fiveHour', remainingPoints: 80, windowStartedAt: new Date(now).toISOString(), resetAt: new Date(now + 1000).toISOString() });
      data.quotaUsage.push({ userId: 'legacy-user', window: 'weekly', remainingPoints: 900, windowStartedAt: new Date(now).toISOString(), resetAt: new Date(now + 1000).toISOString() });
    });
    const migrated = await getQuotaUsage(store, 'legacy-user', now);
    const migratedRecords = store.read((data) => data.quotaUsage.filter((item) => item.userId === 'legacy-user'));
    assert.equal(migratedRecords.find((item) => item.window === 'fiveHour').remainingPoints, QUOTA_WINDOWS.fiveHour.capacity - 20);
    assert.equal(migratedRecords.find((item) => item.window === 'weekly').remainingPoints, QUOTA_WINDOWS.weekly.capacity - 100);
    assert.equal(migrated.windows.fiveHour.remainingPercent, 100);
    assert.equal(migrated.windows.weekly.remainingPercent, 100);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

