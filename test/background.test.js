'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { FileStore } = require('../lib/storage');
const { QUOTA_WINDOWS } = require('../lib/quota');
const { queueGeneration } = require('../server');

test('background generation finishes and persists after the enqueue response is returned', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etherking-background-'));
  const originalFetch = global.fetch;
  const originalKey = process.env.OAAPI;
  process.env.OAAPI = 'test-key';
  global.fetch = async (url) => {
    if (String(url).endsWith('/chat/completions')) {
      return new Response('data: {"choices":[{"delta":{"content":"Background reply"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const store = await new FileStore(path.join(directory, 'store.json')).init();
    const userId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    await store.mutate((data) => {
      data.users.push({ id: userId });
      data.chats.push({ id: chatId, userId, title: 'Existing title', model: 'gpt-5.4-mini', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });
    const queued = await queueGeneration(store, {
      userId,
      chatId,
      model: 'gpt-5.4-mini',
      prepare(data) {
        const message = { id: crypto.randomUUID(), chatId, userId, role: 'user', content: 'Run in the background', createdAt: new Date().toISOString() };
        data.messages.push(message);
        return message;
      }
    });
    assert.equal(queued.job.status, 'queued');
    assert.equal(queued.job.content, '');
    assert.equal(queued.job.isDone, false);

    const deadline = Date.now() + 2000;
    let status;
    do {
      status = store.read((data) => data.generationJobs.find((job) => job.id === queued.job.id)?.status);
      if (status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);

    assert.equal(status, 'completed');
    assert.equal(store.read((data) => data.messages.find((message) => message.role === 'assistant')?.content), 'Background reply');
    const completedJob = store.read((data) => data.generationJobs.find((job) => job.id === queued.job.id));
    const expectedLength = Array.from('Run in the background').length + Array.from('Background reply').length;
    assert.equal(completedJob.content, 'Background reply');
    assert.equal(completedJob.isDone, true);
    assert.equal(completedJob.lengthUnits, expectedLength);
    assert.equal(completedJob.multiplier, 1);
    assert.equal(completedJob.chargedPoints, expectedLength);
    const quota = store.read((data) => data.quotaUsage.filter((item) => item.userId === userId));
    assert.equal(quota.find((item) => item.window === 'fiveHour').remainingPoints, QUOTA_WINDOWS.fiveHour.capacity - expectedLength);
    assert.equal(quota.find((item) => item.window === 'weekly').remainingPoints, QUOTA_WINDOWS.weekly.capacity - expectedLength);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OAAPI;
    else process.env.OAAPI = originalKey;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

