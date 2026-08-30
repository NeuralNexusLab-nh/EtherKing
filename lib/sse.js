'use strict';

class SseTextDecoder {
  constructor(onText) {
    this.buffer = '';
    this.onText = onText;
  }

  push(value) {
    this.buffer += value;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) this.processLine(line);
  }

  flush() {
    if (this.buffer) this.processLine(this.buffer);
    this.buffer = '';
  }

  processLine(line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Ignore malformed provider events without leaking provider payloads.
      return;
    }
    const text = parsed.choices?.[0]?.delta?.content;
    if (typeof text === 'string' && text) this.onText(text);
  }
}

module.exports = { SseTextDecoder };

