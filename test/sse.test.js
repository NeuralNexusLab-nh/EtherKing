'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SseTextDecoder } = require('../lib/sse');

test('decodes provider text across arbitrary chunks', () => {
  let output = '';
  const decoder = new SseTextDecoder((text) => { output += text; });
  decoder.push('data: {"choices":[{"delta":{"cont');
  decoder.push('ent":"Hel"}}]}\n');
  decoder.push('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n');
  decoder.flush();
  assert.equal(output, 'Hello');
});

test('ignores comments, malformed events, and empty deltas', () => {
  const values = [];
  const decoder = new SseTextDecoder((text) => values.push(text));
  decoder.push(': keepalive\ndata: nope\ndata: {"choices":[{"delta":{}}]}\n');
  decoder.flush();
  assert.deepEqual(values, []);
});

test('propagates consumer errors so generation limits can stop a stream', () => {
  const decoder = new SseTextDecoder(() => {
    const error = new Error('Storage limit reached.');
    error.code = 'STORAGE_EXHAUSTED';
    throw error;
  });
  assert.throws(
    () => decoder.push('data: {"choices":[{"delta":{"content":"hello"}}]}\n'),
    (error) => error.code === 'STORAGE_EXHAUSTED'
  );
});

