import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonlTail, readLatestJsonlRecord } from '../src/tail.js';

async function logFile(t, content) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  await writeFile(file, content);
  return file;
}
const context = (model, extra = {}) => JSON.stringify({ type: 'turn_context', payload: { model, ...extra } });
const isContext = (record) => record?.type === 'turn_context';

test('metadata recovery returns the latest complete match and ignores malformed and partial records', async (t) => {
  const file = await logFile(t, `${context('old')}\n${context('current')}\r\ninvalid\n${context('partial')}`);
  assert.equal((await readLatestJsonlRecord(file, isContext)).payload.model, 'current');
});

test('metadata recovery joins records across backward chunks without corrupting Unicode', async (t) => {
  const file = await logFile(t, `${context('old')}\n${context('current', { note: '星'.repeat(100_000) })}\n${JSON.stringify({ type: 'padding', text: 'x'.repeat(300_000) })}\n`);
  const record = await readLatestJsonlRecord(file, isContext);
  assert.equal(record.payload.model, 'current');
  assert.equal(record.payload.note, '星'.repeat(100_000));
});

test('metadata recovery respects its byte budget and discards a cut first record', async (t) => {
  const old = `${context('outside')}\n`;
  const suffix = `${JSON.stringify({ type: 'padding', text: 'x'.repeat(300_000) })}\n`;
  const file = await logFile(t, old + suffix);
  assert.equal(await readLatestJsonlRecord(file, isContext, { maxBytes: suffix.length }), null);
  assert.equal(await readLatestJsonlRecord(file, isContext, { maxBytes: old.length + suffix.length - 1 }), null);
  assert.equal((await readLatestJsonlRecord(file, isContext, { maxBytes: old.length + suffix.length })).payload.model, 'outside');
});

test('metadata recovery is safe for empty, incomplete, missing and unknown records', async (t) => {
  for (const content of ['', context('partial'), 'null\n[]\n{}\n']) {
    const file = await logFile(t, content);
    assert.equal(await readLatestJsonlRecord(file, isContext), null);
  }
  assert.equal(await readLatestJsonlRecord(path.join(os.tmpdir(), 'missing-agentarium-metadata-file'), isContext), null);
});

test('metadata recovery shares the initial tail snapshot boundary', async (t) => {
  const original = `${context('initial')}\n`;
  const file = await logFile(t, original);
  const snapshot = await new JsonlTail().read(file);
  assert.equal(snapshot.endOffset, Buffer.byteLength(original));
  await appendFile(file, `${context('appended')}\n`);
  const recovered = await readLatestJsonlRecord(file, isContext, { endOffset: snapshot.endOffset });
  assert.equal(recovered.payload.model, 'initial');
  assert.equal((await readLatestJsonlRecord(file, isContext)).payload.model, 'appended');
});

test('initial partial reads are identified even when the head contains no complete record', async (t) => {
  const padding = JSON.stringify({ type: 'padding', text: 'x'.repeat(400_000) });
  for (const content of [padding, padding + '\n' + context('tail') + '\n']) {
    const file = await logFile(t, content);
    const reader = new JsonlTail();
    const snapshot = await reader.read(file);
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.metaRecords, []);
    assert.notEqual((await reader.read(file)).truncated, true);
  }
  const small = await logFile(t, context('small') + '\n');
  assert.notEqual((await new JsonlTail().read(small)).truncated, true);
});
