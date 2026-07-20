'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NdjsonTextDecoder } = require('../lib/ndjson');

test('decodes Ollama newline-delimited JSON across chunk boundaries', () => {
  const values = [];
  const decoder = new NdjsonTextDecoder((value) => values.push(value));
  decoder.push('{"message":{"content":"Hel');
  decoder.push('lo"},"done":false}\n{"message":{"content":"!"},');
  decoder.push('"done":true}\n');
  decoder.flush();
  assert.deepEqual(values.map((value) => value.message.content), ['Hello', '!']);
  assert.equal(values[1].done, true);
});

