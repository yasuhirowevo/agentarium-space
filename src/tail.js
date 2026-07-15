import fs from 'node:fs';
import { stat } from 'node:fs/promises';

const LARGE_FILE_BYTES = 256 * 1024;
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 256 * 1024;
const MAX_PARTIAL_LINE_BYTES = 8 * 1024 * 1024;

function debug(message, error) {
  if (process.env.AGENTARIUM_DEBUG) {
    console.error(`[tail] ${message}`, error ?? '');
  }
}

function parseLines(buffer, keepPartial) {
  const records = [];
  let start = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;

    let line = buffer.subarray(start, index);
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    start = index + 1;
    if (line.length === 0) continue;

    try {
      records.push(JSON.parse(line.toString('utf8')));
    } catch (error) {
      debug('ignored an invalid JSONL record', error);
    }
  }

  return {
    records,
    remainder: keepPartial ? buffer.subarray(start) : Buffer.alloc(0),
  };
}

function readRange(filePath, start, end) {
  if (end < start) return Promise.resolve(Buffer.alloc(0));

  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export class JsonlTail {
  #files = new Map();

  forget(filePath) {
    this.#files.delete(filePath);
  }

  async read(filePath) {
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      debug(`could not stat ${filePath}`, error);
      return { metaRecords: [], records: [], reset: false };
    }

    const previous = this.#files.get(filePath);
    const reset = Boolean(previous && fileStat.size < previous.offset);
    const state = reset || !previous
      ? { offset: 0, buffer: Buffer.alloc(0), discardingPartial: false }
      : previous;

    if (!previous || reset) {
      try {
        const initial = await this.#readInitial(filePath, fileStat.size, state);
        this.#files.set(filePath, state);
        return { ...initial, reset };
      } catch (error) {
        debug(`could not read ${filePath}`, error);
        return { metaRecords: [], records: [], reset };
      }
    }

    if (fileStat.size === state.offset) {
      return { metaRecords: [], records: [], reset: false };
    }

    try {
      let chunk = await readRange(filePath, state.offset, fileStat.size - 1);
      state.offset = fileStat.size;

      if (state.discardingPartial) {
        const firstNewline = chunk.indexOf(0x0a);
        if (firstNewline === -1) {
          return { metaRecords: [], records: [], reset: false };
        }
        chunk = chunk.subarray(firstNewline + 1);
        state.discardingPartial = false;
      }

      const parsed = parseLines(Buffer.concat([state.buffer, chunk]), true);
      state.buffer = parsed.remainder;
      if (state.buffer.length > MAX_PARTIAL_LINE_BYTES) {
        state.buffer = Buffer.alloc(0);
        state.discardingPartial = true;
      }
      return { metaRecords: [], records: parsed.records, reset: false };
    } catch (error) {
      debug(`could not read appended data from ${filePath}`, error);
      return { metaRecords: [], records: [], reset: false };
    }
  }

  async #readInitial(filePath, size, state) {
    state.offset = size;
    state.buffer = Buffer.alloc(0);
    state.discardingPartial = false;
    if (size === 0) return { metaRecords: [], records: [] };

    if (size <= LARGE_FILE_BYTES) {
      const content = await readRange(filePath, 0, size - 1);
      const parsed = parseLines(content, true);
      state.buffer = parsed.remainder;
      return { metaRecords: [], records: parsed.records };
    }

    const headEnd = Math.min(HEAD_BYTES, size) - 1;
    const head = await readRange(filePath, 0, headEnd);
    const headRecords = parseLines(head, false).records;

    // Avoid parsing the overlap twice for files only slightly larger than 256 KB.
    const tailStart = Math.max(headEnd + 1, size - TAIL_BYTES);
    let tail = await readRange(filePath, tailStart, size - 1);
    if (tailStart > 0) {
      const firstNewline = tail.indexOf(0x0a);
      if (firstNewline === -1) return { metaRecords: headRecords, records: [] };
      tail = tail.subarray(firstNewline + 1);
    }

    const parsedTail = parseLines(tail, true);
    state.buffer = parsedTail.remainder;
    return { metaRecords: headRecords, records: parsedTail.records };
  }
}
