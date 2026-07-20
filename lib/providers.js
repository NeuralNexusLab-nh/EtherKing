'use strict';

const { NdjsonTextDecoder } = require('./ndjson');
const { SseTextDecoder } = require('./sse');

const MODEL_REGISTRY = Object.freeze({
  'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', provider: 'DeepSeek', plan: 'plus' },
  'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', provider: 'DeepSeek', plan: 'basic' },
  'gpt-4o': { name: 'GPT-4o', provider: 'OpenAI', plan: 'basic' },
  'gpt-4.1': { name: 'GPT-4.1', provider: 'OpenAI', plan: 'basic' },
  'gpt-5-nano': { name: 'GPT-5 Nano', provider: 'OpenAI', plan: 'pro', flex: true },
  'gpt-4o-mini': { name: 'GPT-4o Mini', provider: 'OpenAI', plan: 'pro' },
  'gpt-4.1-nano': { name: 'GPT-4.1 Nano', provider: 'OpenAI', plan: 'pro' },
  'gpt-5-mini': { name: 'GPT-5 Mini', provider: 'OpenAI', plan: 'pro', flex: true },
  'gpt-5': { name: 'GPT-5', provider: 'OpenAI', plan: 'basic', flex: true },
  'gpt-5.1': { name: 'GPT-5.1', provider: 'OpenAI', plan: 'basic', flex: true },
  'gpt-5.2': { name: 'GPT-5.2', provider: 'OpenAI', plan: 'basic', flex: true },
  'o4-mini': { name: 'o4-mini', provider: 'OpenAI', plan: 'pro', flex: true },
  'gpt-5.4': { name: 'GPT-5.4', provider: 'OpenAI', plan: 'basic', flex: true },
  'gpt-5.4-nano': { name: 'GPT-5.4 Nano', provider: 'OpenAI', plan: 'pro', flex: true },
  'gpt-5.4-mini': { name: 'GPT-5.4 Mini', provider: 'OpenAI', plan: 'pro', flex: true },
  'gemma4:31b': { name: 'Gemma 4', provider: 'Ollama', plan: 'plus' },
  'qwen3.5:397b': { name: 'Qwen 3.5', provider: 'Ollama', plan: 'plus' },
  'minimax-m2.7': { name: 'MiniMax M2.7', provider: 'Ollama', plan: 'plus' },
  'nemotron-3-super': { name: 'Nemotron 3 Super', provider: 'Ollama', plan: 'plus' },
  'nemotron-3-nano:30b': { name: 'Nemotron 3 Nano', provider: 'Ollama', plan: 'plus' },
  'mistral-large-3:675b': { name: 'Mistral Large 3', provider: 'Ollama', plan: 'plus' },
  'gpt-oss:120b': { name: 'GPT OSS', provider: 'Ollama', plan: 'plus' }
});

function apiKeyFor(config) {
  if (config.provider === 'DeepSeek') return process.env.DSAPI;
  if (config.provider === 'Ollama') return process.env.OLAPI;
  return process.env.OAAPI;
}

function providerRequest(model, config, history) {
  if (config.provider === 'DeepSeek') {
    return {
      url: 'https://api.deepseek.com/chat/completions',
      body: { model, messages: history, stream: true, thinking: { type: 'disabled' } },
      format: 'sse'
    };
  }
  if (config.provider === 'Ollama') {
    return {
      url: 'https://ollama.com/api/chat',
      body: { model, messages: history, stream: true, think: false },
      format: 'ndjson'
    };
  }
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    body: { model, messages: history, stream: true, ...(config.flex ? { service_tier: 'flex' } : {}) },
    format: 'sse'
  };
}

async function streamProviderText(model, config, history, onText, options = {}) {
  const apiKey = apiKeyFor(config);
  if (!apiKey) {
    const error = new Error(`${config.provider} is not configured.`);
    error.code = 'PROVIDER_NOT_CONFIGURED';
    throw error;
  }
  const request = providerRequest(model, config, history);
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(request.body),
    signal: options.signal
  });
  if (!response.ok || !response.body) {
    const error = new Error('The model provider rejected the request.');
    error.code = 'PROVIDER_REJECTED';
    throw error;
  }

  const textDecoder = new TextDecoder();
  const parser = request.format === 'ndjson'
    ? new NdjsonTextDecoder((value) => {
      const text = value?.message?.content;
      if (typeof text === 'string' && text) onText(text);
    })
    : new SseTextDecoder(onText);
  for await (const chunk of response.body) parser.push(textDecoder.decode(chunk, { stream: true }));
  parser.push(textDecoder.decode());
  parser.flush();
}

async function generateShortTitle(firstMessage, fallbackTitle, options = {}) {
  if (!process.env.OAAPI) return fallbackTitle;
  try {
    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OAAPI}` },
      body: JSON.stringify({
        model: 'gpt-5.4-nano',
        messages: [
          { role: 'system', content: 'Create a concise chat title of at most six words. Return only the title, without quotes or ending punctuation.' },
          { role: 'user', content: firstMessage }
        ],
        stream: false,
        max_completion_tokens: 32
      }),
      signal: options.signal
    });
    if (!response.ok) return fallbackTitle;
    const payload = await response.json();
    const title = String(payload?.choices?.[0]?.message?.content || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/^["'`]+|["'`.!?]+$/g, '')
      .trim()
      .slice(0, 60);
    return title || fallbackTitle;
  } catch {
    return fallbackTitle;
  }
}

module.exports = {
  MODEL_REGISTRY,
  apiKeyFor,
  generateShortTitle,
  providerRequest,
  streamProviderText
};

