'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  USER_STORAGE_CAPACITY_BYTES,
  assertUserStorageWithinLimit,
  getUserStorageBytes,
  getUserStorageUsage
} = require('../lib/user-storage');

function dataWithRecords() {
  return {
    chats: [
      { id: 'chat-a', userId: 'user-a', title: 'A' },
      { id: 'chat-b', userId: 'user-b', title: 'B' }
    ],
    messages: [
      { id: 'message-a', chatId: 'chat-a', userId: 'user-a', role: 'user', content: 'hello' },
      { id: 'message-b', chatId: 'chat-b', userId: 'user-b', role: 'user', content: 'other user data' }
    ]
  };
}

test('calculates a separate 200 KiB chat storage allowance for each user', () => {
  const data = dataWithRecords();
  const expected = Buffer.byteLength(JSON.stringify(data.chats[0]), 'utf8')
    + Buffer.byteLength(JSON.stringify(data.messages[0]), 'utf8');
  assert.equal(getUserStorageBytes(data, 'user-a'), expected);
  const usage = getUserStorageUsage(data, 'user-a');
  assert.equal(usage.usedBytes, expected);
  assert.equal(usage.capacityBytes, 200 * 1024);
  assert.equal(usage.remainingBytes, USER_STORAGE_CAPACITY_BYTES - expected);
  assert.ok(usage.usedPercent > 0);
});

test('rejects chat data that exceeds the per-user storage limit', () => {
  const data = dataWithRecords();
  data.messages.push({ id: 'large', chatId: 'chat-a', userId: 'user-a', role: 'user', content: 'x'.repeat(USER_STORAGE_CAPACITY_BYTES) });
  assert.throws(() => assertUserStorageWithinLimit(data, 'user-a'), (error) => error.code === 'STORAGE_EXHAUSTED');
  assert.doesNotThrow(() => assertUserStorageWithinLimit(data, 'user-b'));
});
