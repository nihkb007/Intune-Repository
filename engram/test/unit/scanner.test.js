'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../../src/core/store');
const { Scanner } = require('../../src/core/scanner');
const { tmp, transcript, writeSession, U } = require('./helpers');

function setup() {
  const root = tmp();
  const a = path.join(root, 'acctA');
  const b = path.join(root, 'acctB');
  const data = path.join(root, 'data');
  const store = new Store(data);
  store.upsertAccount({ id: 'A', name: 'A', configDir: a });
  const A = store.data.accounts[0];
  const B = store.upsertAccount({ name: 'B', configDir: b });
  return { root, a, b, data, store, A, B, scanner: new Scanner({ store, dataDir: data }) };
}

test('aggregates cost per project, account and model', () => {
  const { a, b, scanner, A, B } = setup();
  writeSession(a, '-work-alpha', 's1', transcript({ sessionId: 's1', cwd: '/work/alpha', turns: [{ prompt: 'p', model: 'claude-sonnet-5', usage: U(1_000_000, 0) }] }));
  writeSession(b, '-work-beta', 's2', transcript({ sessionId: 's2', cwd: '/work/beta', turns: [{ prompt: 'p', model: 'claude-opus-5', usage: U(1_000_000, 0) }] }));
  const m = scanner.scan();
  assert.equal(m.totals.sessions, 2);
  assert.equal(Math.round(m.totals.cost * 100) / 100, 7); // $2 + $5
  assert.deepEqual(m.projects.map((p) => p.name), ['beta', 'alpha']);
  assert.equal(m.accounts.find((x) => x.id === A.id).cost, 2);
  assert.equal(m.accounts.find((x) => x.id === B.id).cost, 5);
  assert.deepEqual(m.models.map((x) => x.label), ['Opus 5', 'Sonnet 5']);
});

test('the same messages in two files (resume / bridged copy) are not double counted', () => {
  const { a, b, scanner } = setup();
  const text = transcript({ sessionId: 'dup', turns: [{ prompt: 'p', usage: U(1_000_000, 0) }] });
  writeSession(a, '-work-x', 'dup', text);
  writeSession(b, '-work-x', 'dup', text);
  const m = scanner.scan();
  assert.equal(m.totals.sessions, 1);
  assert.equal(m.totals.cost, 2);
});

test('recordings survive after Claude Code deletes the original transcript', () => {
  const { a, scanner, store } = setup();
  const f = writeSession(a, '-work-x', 'keep', transcript({ sessionId: 'keep', turns: [{ prompt: 'remember me', usage: U(10, 10) }] }));
  scanner.scan();
  assert.ok(store.data.recordings.keep, 'archived');
  fs.unlinkSync(f);
  const m = scanner.scan();
  const s = m.sessions.find((x) => x.id === 'keep');
  assert.ok(s, 'still listed');
  assert.equal(s.archived, true);
  assert.ok(scanner.replay('keep').events.length > 0, 'replayable from archive');
});

test('pricing overrides change computed cost', () => {
  const { a, scanner, store } = setup();
  writeSession(a, '-w', 's', transcript({ sessionId: 's', turns: [{ prompt: 'p', model: 'claude-sonnet-5', usage: U(1_000_000, 0) }] }));
  store.updateSettings({ pricingOverrides: { 'claude-sonnet-5': { input: 10, output: 10, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 } } });
  assert.equal(scanner.scan().totals.cost, 10);
});

test('context tokens track the last main-chain window', () => {
  const { a, scanner } = setup();
  writeSession(a, '-w', 'c', transcript({ sessionId: 'c', turns: [{ prompt: '1', usage: U(5, 1, 100, 1000) }, { prompt: '2', usage: U(7, 1, 200, 5000) }] }));
  const s = scanner.scan().sessions[0];
  assert.equal(s.contextTokens, 7 + 200 + 5000);
});
