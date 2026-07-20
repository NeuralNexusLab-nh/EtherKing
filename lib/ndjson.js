'use strict';

class NdjsonTextDecoder {
  constructor(onValue) {
    this.buffer = '';
    this.onValue = onValue;
  }

  push(text) {
    this.buffer += text;
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.onValue(JSON.parse(line));
    }
  }

  flush() {
    const line = this.buffer.trim();
    this.buffer = '';
    if (line) this.onValue(JSON.parse(line));
  }
}

module.exports = { NdjsonTextDecoder };

