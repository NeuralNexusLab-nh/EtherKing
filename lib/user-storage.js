'use strict';

const USER_STORAGE_CAPACITY_BYTES = 200 * 1024;

function recordBytes(record) {
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}

function getUserStorageBytes(data, userId) {
  const chats = data.chats.filter((chat) => chat.userId === userId);
  const messages = data.messages.filter((message) => message.userId === userId);
  return [...chats, ...messages].reduce((total, record) => total + recordBytes(record), 0);
}

function getUserStorageUsage(data, userId) {
  const usedBytes = getUserStorageBytes(data, userId);
  return {
    usedBytes,
    capacityBytes: USER_STORAGE_CAPACITY_BYTES,
    remainingBytes: Math.max(0, USER_STORAGE_CAPACITY_BYTES - usedBytes),
    usedPercent: Math.round(Math.max(0, Math.min(100, (usedBytes / USER_STORAGE_CAPACITY_BYTES) * 100)) * 10) / 10
  };
}

function storageLimitError() {
  const error = new Error('Your 200 KiB cloud storage limit has been reached. Delete a chat to free space.');
  error.code = 'STORAGE_EXHAUSTED';
  return error;
}

function assertUserStorageWithinLimit(data, userId) {
  if (getUserStorageBytes(data, userId) > USER_STORAGE_CAPACITY_BYTES) throw storageLimitError();
}

module.exports = {
  USER_STORAGE_CAPACITY_BYTES,
  assertUserStorageWithinLimit,
  getUserStorageBytes,
  getUserStorageUsage,
  recordBytes,
  storageLimitError
};
