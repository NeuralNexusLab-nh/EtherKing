'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('the bundled Markdown parser supports GFM links, tables, and nested lists', async () => {
  const { marked } = await import('marked');
  const html = marked.parse([
    '[hi](https://example.com)',
    '',
    '| Name | Value |',
    '| --- | ---: |',
    '| Alpha | 42 |',
    '',
    '- parent',
    '  - child',
    '',
    '~~deleted~~'
  ].join('\n'), { gfm: true, breaks: true });
  assert.match(html, /<a href="https:\/\/example\.com">hi<\/a>/);
  assert.match(html, /<table>/);
  assert.match(html, /align="right"/);
  assert.match(html, /<ul>[\s\S]*<ul>/);
  assert.match(html, /<del>deleted<\/del>/);
});
