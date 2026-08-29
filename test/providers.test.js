'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL_REGISTRY, generateShortTitle, providerRequest, searchPublicWeb, streamProviderText } = require('../lib/providers');

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
  for (const id of ['deepseek-v4-pro', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-5.6-sol']) {
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
  for (const id of ['gpt-5-nano', 'gpt-4o-mini', 'gpt-4.1-nano', 'gpt-5-mini', 'o4-mini', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    assert.equal(MODEL_REGISTRY[id].plan, 'basic');
  }
});

test('aborts a slow OpenAI Flex request before retrying with the default service tier', async () => {
  const originalKey = process.env.OAAPI;
  process.env.OAAPI = 'test-key';
  const bodies = [];
  let flexSignal;
  try {
    let callCount = 0;
    let output = '';
    await streamProviderText('gpt-5.6-luna', MODEL_REGISTRY['gpt-5.6-luna'], [{ role: 'user', content: 'Hello' }], (text) => {
      output += text;
    }, {
      flexFirstTextTimeoutMs: 10,
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.openai.com/v1/chat/completions');
        bodies.push(JSON.parse(options.body));
        callCount += 1;
        if (callCount === 1) {
          flexSignal = options.signal;
          const body = new ReadableStream({
            start(controller) {
              options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
            }
          });
          return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        assert.equal(flexSignal.aborted, true);
        return new Response('data: {"choices":[{"delta":{"content":"Standard reply"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }
    });
    assert.equal(output, 'Standard reply');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].service_tier, 'flex');
    assert.equal(bodies[1].service_tier, 'default');
    assert.deepEqual(bodies[1].messages, bodies[0].messages);
  } finally {
    if (originalKey === undefined) delete process.env.OAAPI;
    else process.env.OAAPI = originalKey;
  }
});

test('searches the public web with GPT-5.6 Luna and returns safe deduplicated sources', async () => {
  const originalKey = process.env.OAAPI;
  process.env.OAAPI = 'test-key';
  let requestBody;
  try {
    const result = await searchPublicWeb('latest public information', {
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        requestBody = JSON.parse(options.body);
        return new Response(JSON.stringify({
          output: [
            { type: 'web_search_call', action: { sources: [
              { title: 'Example source', url: 'https://example.com/news' },
              { title: 'Duplicate', url: 'https://example.com/news' },
              { title: 'Unsafe', url: 'javascript:alert(1)' }
            ] } },
            { type: 'message', content: [{
              type: 'output_text',
              text: 'Current research notes.',
              annotations: [{ type: 'url_citation', title: 'Second source', url: 'https://docs.example.org/page' }]
            }] }
          ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });
    assert.equal(requestBody.model, 'gpt-5.6-luna');
    assert.deepEqual(requestBody.tools, [{ type: 'web_search' }]);
    assert.deepEqual(requestBody.include, ['web_search_call.action.sources']);
    assert.equal(requestBody.store, false);
    assert.equal(result.text, 'Current research notes.');
    assert.deepEqual(result.sources, [
      { title: 'Example source', url: 'https://example.com/news' },
      { title: 'Second source', url: 'https://docs.example.org/page' }
    ]);
  } finally {
    if (originalKey === undefined) delete process.env.OAAPI;
    else process.env.OAAPI = originalKey;
  }
});

