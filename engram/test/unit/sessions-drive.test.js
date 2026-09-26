'use strict';
// "Sessions on the drive": two laptops, two accounts, one external drive holding both the
// project files and Claude Code's sessions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const drive = require('../../src/core/drive');
const sync = require('../../src/core/sync');
const { Store } = require('../../src/core/store');
const { Scanner } = require('../../src/core/scanner');
const { tmp, transcript, writeSession, U } = require('./helpers');

const session = (dir, id, prompt, usage, model = 'claude-sonnet-5') =>
  writeSession(dir, '-E-code-app', id, transcript({ sessionId: id, cwd: 'E:\\code\\app', turns: [{ prompt, model, usage }] }));

test('one click moves a laptop\'s sessions onto the drive and links Claude Code to them', () => {
  const usb = tmp('engram-usb-');
  const target = drive.sessionsTarget(usb);
  const acct = { id: 'a', configDir: path.join(tmp('engram-lap-'), '.claude') };
  session(acct.configDir, 's1', 'existing work', U(10, 10));

  assert.equal(drive.accountStatus(acct, target).state, 'local');
  const r = drive.shareAccount(acct, target);
  assert.equal(r.copied, 1);
  assert.ok(fs.existsSync(r.backup), 'original folder kept as a backup');
  assert.equal(drive.accountStatus(acct, target).state, 'shared');
  // Claude Code reading its usual folder now sees the drive's files.
  assert.ok(fs.existsSync(path.join(acct.configDir, 'projects', '-E-code-app', 's1.jsonl')));
  assert.ok(fs.existsSync(path.join(target, '-E-code-app', 's1.jsonl')));
  // New sessions written through Claude's folder land on the drive.
  session(acct.configDir, 's2', 'new', U(1, 1));
  assert.ok(fs.existsSync(path.join(target, '-E-code-app', 's2.jsonl')));
  // Clicking again does nothing.
  assert.equal(drive.shareAccount(acct, target).already, true);
});

test('second laptop merges its own sessions in; both see everything; larger copies win', () => {
  const usb = tmp('engram-usb-');
  const target = drive.sessionsTarget(usb);
  const work = { id: 'w', configDir: path.join(tmp('engram-w-'), '.claude') };
  const home = { id: 'h', configDir: path.join(tmp('engram-h-'), '.claude') };
  session(work.configDir, 'shared', 'short', U(1, 1));
  session(home.configDir, 'homeonly', 'home', U(1, 1));
  const longer = transcript({ sessionId: 'shared', cwd: 'E:\\code\\app', turns: [{ prompt: 'short', usage: U(1, 1) }, { prompt: 'longer', usage: U(1, 1) }] });
  writeSession(home.configDir, '-E-code-app', 'shared', longer);

  drive.shareAccount(work, target);
  drive.shareAccount(home, target);
  const files = fs.readdirSync(path.join(target, '-E-code-app')).sort();
  assert.deepEqual(files, ['homeonly.jsonl', 'shared.jsonl']);
  assert.equal(fs.readFileSync(path.join(target, '-E-code-app', 'shared.jsonl'), 'utf8'), longer);
  assert.deepEqual(fs.readdirSync(path.join(work.configDir, 'projects', '-E-code-app')).sort(), files, 'work laptop sees home sessions');
});

test('stop sharing gives the laptop a normal folder with copies', () => {
  const usb = tmp('engram-usb-');
  const target = drive.sessionsTarget(usb);
  const acct = { id: 'a', configDir: path.join(tmp('engram-lap-'), '.claude') };
  session(acct.configDir, 's1', 'x', U(1, 1));
  drive.shareAccount(acct, target);
  const r = drive.unshareAccount(acct, target);
  assert.equal(r.state, 'local');
  const projects = path.join(acct.configDir, 'projects');
  assert.ok(!fs.lstatSync(projects).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(projects, '-E-code-app', 's1.jsonl')));
  assert.ok(fs.existsSync(path.join(target, '-E-code-app', 's1.jsonl')), 'drive copy untouched');
});

test('unplugged drive is recognised, and re-sharing repairs the link', () => {
  const usb = tmp('engram-usb-');
  const target = drive.sessionsTarget(usb);
  const acct = { id: 'a', configDir: path.join(tmp('engram-lap-'), '.claude') };
  drive.shareAccount(acct, target);
  fs.rmSync(usb, { recursive: true, force: true });
  assert.equal(drive.accountStatus(acct, target).state, 'unplugged');
  fs.mkdirSync(usb);
  assert.equal(drive.shareAccount(acct, target).state, 'shared');
});

test('drive letter is remembered and a different letter is flagged', () => {
  const usb = tmp('engram-usb-');
  const target = drive.sessionsTarget(usb);
  assert.equal(drive.letterOf('e:\\'), 'E:');
  assert.deepEqual(drive.letterCheck('E:\\', target, { remember: true }), { expected: 'E:', actual: 'E:', ok: true });
  assert.deepEqual(drive.letterCheck('F:\\', target), { expected: 'E:', actual: 'F:', ok: false });
});

test('Claude Code cleanup is extended without touching other settings', () => {
  const dir = tmp('engram-cfg-');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] } }));
  assert.equal(drive.keepSessionsLonger(dir).changed, true);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(j, { model: 'opus', permissions: { allow: ['Bash(ls)'] }, cleanupPeriodDays: 3650 });
  assert.equal(drive.keepSessionsLonger(dir).changed, false);
});

test('costs stay with the account whose laptop first saw each message', () => {
  const usb = tmp('engram-usb-');
  const target = drive.sessionsTarget(usb);
  const vault = path.join(usb, 'ENGRAM', 'ENGRAM-data', 'vault');
  const workDir = path.join(tmp('engram-w-'), '.claude');
  const homeDir = path.join(tmp('engram-h-'), '.claude');
  const open = (mid, dir) => {
    const store = new Store(vault);
    store.machineOverride = { id: mid, name: mid.toUpperCase() };
    sync.adoptThisMachine(store, [{ name: 'CLAUDE', configDir: dir }]);
    store.data.settings.sharedSessions = true;
    const a = sync.localAccounts(store)[0];
    drive.shareAccount(a, target);
    return { store, acct: a, scan: () => { const m = new Scanner({ store, dataDir: vault }).scan(); store.save(true); return m; } };
  };

  // Work laptop: start a session.
  const work = open('work', workDir);
  session(workDir, 'x', 'start on work', U(1_000_000, 0));
  work.scan();
  // Home laptop: continue the same session (Claude appends to the same file on the drive).
  const home = open('home', homeDir);
  fs.appendFileSync(path.join(homeDir, 'projects', '-E-code-app', 'x.jsonl'),
    transcript({ sessionId: 'x', cwd: 'E:\\code\\app', turns: [{ prompt: 'continue on home', usage: U(2_000_000, 0) }] }).replace(/msg_x_0/g, 'msg_x_h').replace(/req_0/g, 'req_h'));
  let m = home.scan();
  assert.equal(m.totals.sessions, 1);
  assert.equal(m.accounts.find((a) => a.id === home.acct.id).cost, 4);
  assert.equal(m.accounts.find((a) => a.id === work.acct.id).cost, 2);
  // Back on work: same split.
  m = open('work', workDir).scan();
  assert.equal(m.accounts.find((a) => a.id === work.acct.id).cost, 2);
  assert.equal(m.accounts.find((a) => a.id === home.acct.id).cost, 4);
  assert.equal(m.sessions[0].remote, null, 'session is local on both laptops (it lives on the drive)');
});

test('two accounts on one laptop keep their existing costs after joining the drive; new work goes to the active account', () => {
  const usb = tmp('engram-usb-');
  const target = drive.sessionsTarget(usb);
  const home = tmp('engram-lap-');
  const store = new Store(path.join(home, 'vault'));
  store.machineOverride = { id: 'lap', name: 'LAP' };
  sync.adoptThisMachine(store, [{ name: 'WORK', configDir: path.join(home, '.claude') }, { name: 'PERSONAL', configDir: path.join(home, '.claude-personal') }]);
  const [work, personal] = sync.localAccounts(store);
  session(work.configDir, 'w1', 'work', U(1_000_000, 0));
  session(personal.configDir, 'p1', 'personal', U(2_000_000, 0));
  const scan = () => new Scanner({ store, dataDir: path.join(home, 'vault') }).scan();

  // What the SHARE button does: record ownership first, then join the folders.
  store.data.settings.sharedSessions = true;
  scan();
  drive.shareAccount(work, target);
  drive.shareAccount(personal, target);
  let m = scan();
  const cost = (id) => m.accounts.find((a) => a.id === id).cost;
  assert.equal(m.totals.sessions, 2);
  assert.equal(cost(work.id), 2);
  assert.equal(cost(personal.id), 4);

  store.data.activeAccountId = personal.id;
  session(work.configDir, 'n1', 'new while personal is active', U(1_000_000, 0));
  m = scan();
  assert.equal(cost(personal.id), 6, 'new message credited to the active account');
  assert.equal(cost(work.id), 2);
});
