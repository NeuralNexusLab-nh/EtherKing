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
    });
    const queued = await queueGeneration(store, {
      userId,
      chatId,
      model: 'gpt-5.4-mini',
      createChat() {
        const now = new Date().toISOString();
        return { id: chatId, userId, title: 'Existing title', model: 'gpt-5.4-mini', createdAt: now, updatedAt: now };
      },
      prepare(data) {
        const message = { id: crypto.randomUUID(), chatId, userId, role: 'user', content: 'Run in the background', createdAt: new Date().toISOString() };
        data.messages.push(message);
        return message;
      }
    });
    assert.equal(queued.job.status, 'queued');
    assert.equal(queued.job.content, '');
    assert.equal(queued.job.isDone, false);
    const queuedSnapshot = store.read((data) => ({
      chat: data.chats.find((item) => item.id === chatId),
      message: data.messages.find((item) => item.id === queued.userMessage.id),
      job: data.generationJobs.find((item) => item.id === queued.job.id)
    }));
    assert.equal(queuedSnapshot.chat.id, chatId);
    assert.equal(queuedSnapshot.message.chatId, chatId);
    assert.equal(queuedSnapshot.job.chatId, chatId);

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

test('web search runs before generation and persists sources with the response', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etherking-search-'));
  const originalFetch = global.fetch;
  const originalOpenAiKey = process.env.OAAPI;
  const originalDeepSeekKey = process.env.DSAPI;
  process.env.OAAPI = 'openai-test-key';
  process.env.DSAPI = 'deepseek-test-key';
  const requests = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/responses')) {
      return new Response(JSON.stringify({
        output: [
          { type: 'web_search_call', action: { sources: [{ title: 'Public source', url: 'https://example.com/current' }] } },
          { type: 'message', content: [{ type: 'output_text', text: 'Fresh public facts.' }] }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('api.deepseek.com')) {
      return new Response('data: {"choices":[{"delta":{"content":"Answer with source"}}]}\n\ndata: [DONE]\n\n', {
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
    await store.mutate((data) => data.users.push({ id: userId }));
    const queued = await queueGeneration(store, {
      userId,
      chatId,
      model: 'deepseek-v4-flash',
      webSearch: true,
      createChat() {
        const now = new Date().toISOString();
        return { id: chatId, userId, title: 'Existing title', model: 'deepseek-v4-flash', createdAt: now, updatedAt: now };
      },
      prepare(data) {
        const message = { id: crypto.randomUUID(), chatId, userId, role: 'user', content: 'What changed today?', createdAt: new Date().toISOString() };
        data.messages.push(message);
        return message;
      }
    });

    const deadline = Date.now() + 2000;
    let status;
    do {
      status = store.read((data) => data.generationJobs.find((job) => job.id === queued.job.id)?.status);
      if (status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);

    assert.equal(status, 'completed');
    assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(requests[1].url, 'https://api.deepseek.com/chat/completions');
    assert.match(requests[1].body.messages[0].content, /Fresh public facts/);
    assert.match(requests[1].body.messages[0].content, /https:\/\/example\.com\/current/);
    const assistant = store.read((data) => data.messages.find((message) => message.role === 'assistant'));
    assert.equal(assistant.webSearch, true);
    assert.deepEqual(assistant.sources, [{ title: 'Public source', url: 'https://example.com/current' }]);
    const job = store.read((data) => data.generationJobs.find((item) => item.id === queued.job.id));
    assert.equal(job.phase, 'completed');
    assert.deepEqual(job.sources, assistant.sources);
  } finally {
    global.fetch = originalFetch;
    if (originalOpenAiKey === undefined) delete process.env.OAAPI;
    else process.env.OAAPI = originalOpenAiKey;
    if (originalDeepSeekKey === undefined) delete process.env.DSAPI;
    else process.env.DSAPI = originalDeepSeekKey;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

