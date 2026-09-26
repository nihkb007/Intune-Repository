'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fuse, injectManagedBlock, MARK_BEGIN, MARK_END } = require('../../src/core/fusion');

const detail = (o) => ({
  id: o.id, accountId: o.acct || 'A', projectPath: '/work/app', title: o.title || o.id, startedAt: o.start, endedAt: o.start,
  cost: 1, contextTokens: 50_000, prompts: o.prompts.map((t) => ({ ts: o.start, text: t })),
  files: o.files || {}, commands: (o.cmds || []).map((c) => ({ cmd: c })), errors: (o.errors || []).map((t) => ({ text: t, tool: 'Bash' })),
  lastAssistantText: o.last || '',
});

test('fuses sessions from different accounts into one capsule', () => {
  const cap = fuse([
    detail({ id: 's2', acct: 'B', start: '2026-09-02', prompts: ['Add retry', 'add retry'], files: { '/work/app/src/a.ts': { read: 1, edit: 2, write: 0 } }, cmds: ['npm test', 'npm  test'], errors: ['429 Too Many Requests'], last: 'Retry added.' }),
    detail({ id: 's1', acct: 'A', start: '2026-09-01', prompts: ['Build the client'], files: { '/work/app/src/a.ts': { read: 3, edit: 0, write: 1 }, '/work/app/README.md': { read: 1, edit: 0, write: 0 } }, cmds: ['npm test'], errors: ['429 Too Many Requests'] }),
  ], { accounts: [{ id: 'A', name: 'WORK' }, { id: 'B', name: 'HOME' }], notes: [{ title: 'Use integer cents', body: 'always', kind: 'directive', pinned: true }] });

  assert.deepEqual(cap.sessionIds, ['s1', 's2'], 'chronological');
  assert.deepEqual(cap.accounts.sort(), ['A', 'B']);
  const md = cap.markdown;
  assert.match(md, /accounts: WORK, HOME/);
  assert.match(md, /## Directives & decisions/);
  assert.match(md, /Use integer cents/);
  assert.equal((md.match(/Add retry/gi) || []).length, 1, 'duplicate prompts collapse');
  assert.match(md, /`src\/a\.ts` \(1× write, 2× edit, 4× read\)/, 'file paths are relative and merged');
  assert.match(md, /`npm test` ×3/, 'commands normalised and counted');
  assert.match(md, /429 Too Many Requests \(×2\)/, 'pitfalls merged');
  assert.equal(cap.stats.rawTokens, 100_000);
  assert.ok(cap.stats.compression > 10);
});

test('empty selection is rejected', () => {
  assert.throws(() => fuse([]), /at least one/);
});

test('managed block is appended, then replaced in place, keeping user content', () => {
  const user = '# My project\n\nHand written rules.\n';
  const once = injectManagedBlock(user, 'v1');
  assert.ok(once.startsWith(user.trim()));
  assert.ok(once.includes(MARK_BEGIN) && once.includes('v1') && once.includes(MARK_END));
  const twice = injectManagedBlock(once + '\nfooter\n', 'v2');
  assert.ok(!twice.includes('v1'));
  assert.ok(twice.includes('v2'));
  assert.ok(twice.includes('footer'));
  assert.equal(twice.split(MARK_END).length, 2, 'exactly one block');
  assert.equal(injectManagedBlock('', 'x'), `${MARK_BEGIN}\nx\n${MARK_END}\n`);
});
