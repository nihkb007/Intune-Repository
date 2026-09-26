'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bridge = require('../../src/core/bridge');
const { Store } = require('../../src/core/store');
const { Scanner } = require('../../src/core/scanner');
const { tmp, transcript, writeSession, U } = require('./helpers');

test('detects Claude config dirs and reads the signed-in email', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@work.dev' } }));
  fs.mkdirSync(path.join(home, '.claude-personal'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-personal', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@home.dev', billingType: 'pro' } }));
  fs.mkdirSync(path.join(home, '.claude-empty'));
  const found = bridge.detectAccounts({ home, env: {} });
  assert.deepEqual(found.map((f) => f.email).sort(), ['me@home.dev', 'me@work.dev']);
  assert.equal(found.find((f) => f.email === 'me@home.dev').plan, 'pro');
});

test('syncSessions mirrors sessions both ways and is idempotent', () => {
  const root = tmp();
  const A = { id: 'A', configDir: path.join(root, 'a') };
  const B = { id: 'B', configDir: path.join(root, 'b') };
  writeSession(A.configDir, '-w-app', 's1', transcript({ sessionId: 's1', turns: [{ prompt: 'p', usage: U(1, 1) }] }));
  writeSession(B.configDir, '-w-app', 's2', transcript({ sessionId: 's2', turns: [{ prompt: 'p', usage: U(1, 1) }] }));

  const dry = bridge.syncSessions([A, B], {}, { dryRun: true });
  assert.equal(dry.plan.length, 2);
  assert.ok(!fs.existsSync(path.join(B.configDir, 'projects', '-w-app', 's1.jsonl')), 'dry run writes nothing');

  const r = bridge.syncSessions([A, B], {});
  assert.equal(r.copied, 2);
  assert.ok(fs.existsSync(path.join(B.configDir, 'projects', '-w-app', 's1.jsonl')));
  assert.ok(fs.existsSync(path.join(A.configDir, 'projects', '-w-app', 's2.jsonl')));
  assert.equal(r.ledger.s1.origin, 'A');
  assert.equal(r.ledger.s2.origin, 'B');

  assert.equal(bridge.syncSessions([A, B], r.ledger).plan.length, 0, 'second run has nothing to do');
});

test('a session continued on the other account propagates back and costs stay attributed', () => {
  const root = tmp();
  const store = new Store(path.join(root, 'data'));
  const A = store.upsertAccount({ name: 'A', configDir: path.join(root, 'a') });
  const B = store.upsertAccount({ name: 'B', configDir: path.join(root, 'b') });
  const base = transcript({ sessionId: 'x', turns: [{ prompt: 'start', usage: U(1_000_000, 0) }] });
  writeSession(A.configDir, '-w', 'x', base);
  store.data.bridgeLedger = bridge.syncSessions(store.data.accounts, {}).ledger;

  // Continue the conversation on account B (new messages appended to B's copy).
  const more = transcript({ sessionId: 'x', turns: [{ prompt: 'continue', usage: U(2_000_000, 0) }] }).replace(/msg_x_0/g, 'msg_x_1').replace(/req_0/g, 'req_1');
  fs.appendFileSync(path.join(B.configDir, 'projects', '-w', 'x.jsonl'), more);

  const r = bridge.syncSessions(store.data.accounts, store.data.bridgeLedger);
  store.data.bridgeLedger = r.ledger;
  assert.deepEqual(r.plan.map((p) => [p.to, p.reason]), [[A.id, 'behind']]);
  assert.equal(fs.readFileSync(path.join(A.configDir, 'projects', '-w', 'x.jsonl'), 'utf8'), fs.readFileSync(path.join(B.configDir, 'projects', '-w', 'x.jsonl'), 'utf8'));

  const m = new Scanner({ store, dataDir: path.join(root, 'data') }).scan();
  assert.equal(m.totals.sessions, 1);
  assert.equal(m.accounts.find((a) => a.id === A.id).cost, 2, 'A paid for the first turn');
  assert.equal(m.accounts.find((a) => a.id === B.id).cost, 4, 'B paid for the continuation');
});

test('syncMemory writes a managed block into each account CLAUDE.md without clobbering it', () => {
  const root = tmp();
  const A = { id: 'A', configDir: path.join(root, 'a') };
  fs.mkdirSync(A.configDir, { recursive: true });
  fs.writeFileSync(path.join(A.configDir, 'CLAUDE.md'), 'mine\n');
  const r = bridge.syncMemory([A], '# rules');
  assert.equal(r[0].changed, true);
  const body = fs.readFileSync(path.join(A.configDir, 'CLAUDE.md'), 'utf8');
  assert.ok(body.startsWith('mine'));
  assert.ok(body.includes('# rules'));
  assert.equal(bridge.syncMemory([A], '# rules')[0].changed, false);
});

test('launch commands set CLAUDE_CONFIG_DIR only for non-default accounts', () => {
  const home = '/home/u';
  const def = { configDir: '/home/u/.claude' };
  const alt = { configDir: "/home/u/.claude-o'brien" };
  assert.equal(bridge.launchCommand(def, { platform: 'linux', home }), 'claude');
  assert.equal(bridge.launchCommand(alt, { platform: 'linux', home, projectPath: '/p', resumeId: 'abc' }), `cd '/p' && CLAUDE_CONFIG_DIR='/home/u/.claude-o'\\''brien' claude --resume abc`);
  assert.equal(bridge.launchCommand({ configDir: 'C:\\Users\\me\\.claude-work' }, { platform: 'win32', home: 'C:\\Users\\me', projectPath: 'C:\\code\\app' }),
    "Set-Location -LiteralPath 'C:\\code\\app'; $env:CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude-work'; claude");
});

test('syncSessions can be limited to specific sessions', () => {
  const root = tmp();
  const A = { id: 'A', configDir: path.join(root, 'a') };
  const B = { id: 'B', configDir: path.join(root, 'b') };
  writeSession(A.configDir, '-w', 'keep', transcript({ sessionId: 'keep', turns: [{ prompt: 'p', usage: U(1, 1) }] }));
  writeSession(A.configDir, '-w', 'skip', transcript({ sessionId: 'skip', turns: [{ prompt: 'p', usage: U(1, 1) }] }));
  const r = bridge.syncSessions([A, B], {}, { only: ['keep'] });
  assert.equal(r.copied, 1);
  assert.ok(fs.existsSync(path.join(B.configDir, 'projects', '-w', 'keep.jsonl')));
  assert.ok(!fs.existsSync(path.join(B.configDir, 'projects', '-w', 'skip.jsonl')));
});
