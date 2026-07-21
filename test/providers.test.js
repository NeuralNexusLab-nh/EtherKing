'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL_REGISTRY, generateShortTitle, providerRequest } = require('../lib/providers');

test('builds Ollama cloud chat requests using the documented NDJSON endpoint', () => {
  const model = 'gpt-oss:120b';
  const history = [{ role: 'user', content: 'Hello' }];
  const request = providerRequest(model, MODEL_REGISTRY[model], history);
  assert.equal(request.url, 'https://ollama.com/api/chat');
  assert.equal(request.format, 'ndjson');
  assert.deepEqual(request.body, { model, messages: history, stream: true, think: false });
});

test('registers every requested Ollama model', () => {
  for (const id of [
    'gemma4:31b',
    'qwen3.5:397b',
    'minimax-m2.7',
    'nemotron-3-super',
    'nemotron-3-nano:30b',
    'mistral-large-3:675b',
    'gpt-oss:120b'
  ]) {
    assert.equal(MODEL_REGISTRY[id].provider, 'Ollama');
    assert.equal(MODEL_REGISTRY[id].plan, 'plus');
  }
});

test('uses gpt-5.4-nano for concise generated chat titles', async () => {
  const originalKey = process.env.OAAPI;
  process.env.OAAPI = 'test-key';
  let body;
  try {
    const title = await generateShortTitle('A long first message', 'Fallback title', {
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.openai.com/v1/chat/completions');
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Short Generated Title.' } }] }), { status: 200 });
      }
    });
    assert.equal(body.model, 'gpt-5.4-nano');
    assert.equal(title, 'Short Generated Title');
  } finally {
    if (originalKey === undefined) delete process.env.OAAPI;
    else process.env.OAAPI = originalKey;
  }
});

test('assigns full GPT and DeepSeek Pro models to Pro', () => {
  for (const id of ['deepseek-v4-pro', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4']) {
    assert.equal(MODEL_REGISTRY[id].plan, 'pro');
  }
});

test('assigns DeepSeek Flash and Ollama models to Plus', () => {
  assert.equal(MODEL_REGISTRY['deepseek-v4-flash'].plan, 'plus');
  for (const [id, config] of Object.entries(MODEL_REGISTRY)) {
    if (config.provider === 'Ollama') assert.equal(config.plan, 'plus', id);
  }
});

test('assigns GPT mini and nano models to Basic', () => {
  for (const id of ['gpt-5-nano', 'gpt-4o-mini', 'gpt-4.1-nano', 'gpt-5-mini', 'o4-mini', 'gpt-5.4-nano', 'gpt-5.4-mini']) {
    assert.equal(MODEL_REGISTRY[id].plan, 'basic');
  }
});

