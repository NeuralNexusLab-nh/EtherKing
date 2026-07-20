'use strict';

const fs = require('fs/promises');
const path = require('path');

const STORAGE_FORMAT = 'etherking-obfuscated-v1';

function emptyStore() {
  return {
    users: [],
    sessions: [],
    chats: [],
    messages: [],
    dailyUsage: [],
    authRateLimits: []
  };
}

function validateStore(value) {
  if (!value || typeof value !== 'object') throw new Error('Storage payload is invalid.');
  const expectedArrays = ['users', 'sessions', 'chats', 'messages', 'dailyUsage', 'authRateLimits'];
  for (const key of expectedArrays) {
    if (!Array.isArray(value[key])) throw new Error(`Storage field ${key} is invalid.`);
  }
  return value;
}

function encodeStore(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return `${JSON.stringify({ format: STORAGE_FORMAT, payload }, null, 2)}\n`;
}

function decodeStore(content) {
  const wrapper = JSON.parse(content);
  if (wrapper?.format !== STORAGE_FORMAT || typeof wrapper.payload !== 'string') {
    throw new Error('Storage file format is not supported.');
  }
  const decoded = Buffer.from(wrapper.payload, 'base64').toString('utf8');
  return validateStore(JSON.parse(decoded));
}

class FileStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.data = emptyStore();
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      this.data = decodeStore(content);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist(this.data);
    }
    this.initialized = true;
    return this;
  }

  read(reader) {
    if (!this.initialized) throw new Error('Storage is not initialized.');
    const snapshot = structuredClone(this.data);
    return reader(snapshot);
  }

  mutate(mutator) {
    if (!this.initialized) return Promise.reject(new Error('Storage is not initialized.'));
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.data);
      const result = await mutator(draft);
      validateStore(draft);
      await this.persist(draft);
      this.data = draft;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async persist(value) {
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, encodeStore(value), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = {
  FileStore,
  STORAGE_FORMAT,
  decodeStore,
  emptyStore,
  encodeStore
};

