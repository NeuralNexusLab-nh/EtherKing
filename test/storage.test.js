'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { FileStore, STORAGE_FORMAT, decodeStore } = require('../lib/storage');

test('persists and reloads an obfuscated store', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etherking-store-'));
  const file = path.join(directory, 'store.json');
  try {
    const store = await new FileStore(file).init();
    await store.mutate((data) => data.users.push({ id: 'user-1', email: 'person@example.com' }));
    const raw = await fs.readFile(file, 'utf8');
    const wrapper = JSON.parse(raw);
    assert.equal(wrapper.format, STORAGE_FORMAT);
    assert.equal(raw.includes('person@example.com'), false);
    assert.equal(decodeStore(raw).users[0].email, 'person@example.com');

    const reloaded = await new FileStore(file).init();
    assert.equal(reloaded.read((data) => data.users[0].id), 'user-1');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('serializes concurrent mutations without losing data', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'etherking-store-'));
  const file = path.join(directory, 'store.json');
  try {
    const store = await new FileStore(file).init();
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.mutate((data) => {
      data.users.push({ id: `user-${index}` });
    })));
    assert.equal(store.read((data) => data.users.length), 20);
    assert.equal(decodeStore(await fs.readFile(file, 'utf8')).users.length, 20);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

