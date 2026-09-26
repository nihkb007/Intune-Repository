'use strict';
// Thumb-drive mode: one portable ENGRAM (one vault folder) used by two laptops in turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sync = require('../../src/core/sync');
const { Store } = require('../../src/core/store');
const { Scanner } = require('../../src/core/scanner');
const { tmp, transcript, writeSession, U } = require('./helpers');

/** Plug the drive into a laptop: load the vault from the drive, as that laptop. */
function plugInto(drive, machine, claudeDir) {
  const store = new Store(path.join(drive, 'ENGRAM-data', 'vault'));
  store.machineOverride = { id: machine, name: machine.toUpperCase() };
  sync.adoptThisMachine(store, [{ name: 'CLAUDE', configDir: claudeDir }]);
  const scanner = new Scanner({ store, dataDir: path.join(drive, 'ENGRAM-data', 'vault') });
  return { store, scanner, scan: () => { const m = scanner.scan(); store.save(true); return m; } };
}

test('each laptop adds its own account once and only scans its own Claude folder', () => {
  const drive = tmp('engram-usb-');
  // Same Windows user name on both laptops -> the very same config path on each.
  const claudeDir = path.join(tmp('engram-home-'), '.claude');

  writeSession(claudeDir, 'w', 'work1', transcript({ sessionId: 'work1', cwd: '/c/app', turns: [{ prompt: 'on work laptop', model: 'claude-sonnet-5', usage: U(1_000_000, 0) }] }));
  const work = plugInto(drive, 'work', claudeDir);
  let m = work.scan();
  assert.equal(m.totals.sessions, 1);
  assert.equal(work.store.data.accounts.length, 1);

  // Unplug; on the personal laptop the same path holds different sessions.
  fs.rmSync(claudeDir, { recursive: true, force: true });
  writeSession(claudeDir, 'h', 'home1', transcript({ sessionId: 'home1', cwd: '/c/app', turns: [{ prompt: 'on home laptop', model: 'claude-opus-5', usage: U(1_000_000, 0) }] }));
  const home = plugInto(drive, 'home', claudeDir);
  m = home.scan();
  assert.equal(home.store.data.accounts.length, 2, 'home laptop account added alongside work');
  assert.equal(m.totals.sessions, 2, 'work history is visible on the home laptop');
  const w = m.sessions.find((s) => s.id === 'work1');
  const h = m.sessions.find((s) => s.id === 'home1');
  assert.equal(w.remote, 'WORK', 'work session shows as from the other laptop');
  assert.equal(h.remote, null);
  const byName = Object.fromEntries(m.accounts.map((a) => [a.name, a.cost]));
  assert.deepEqual(byName, { 'CLAUDE @ WORK': 2, CLAUDE: 5 }, 'costs not mixed despite identical paths');
  assert.equal(home.store.data.activeAccountId, home.store.data.accounts.find((a) => a.machineId === 'home').id, 'active account is local');

  // Back on the work laptop, nothing is re-detected and home history is visible too.
  fs.rmSync(claudeDir, { recursive: true, force: true });
  writeSession(claudeDir, 'w', 'work1', transcript({ sessionId: 'work1', cwd: '/c/app', turns: [{ prompt: 'on work laptop', model: 'claude-sonnet-5', usage: U(1_000_000, 0) }] }));
  const again = plugInto(drive, 'work', claudeDir);
  m = again.scan();
  assert.equal(again.store.data.accounts.length, 2);
  assert.equal(m.totals.sessions, 2);
  assert.equal(m.sessions.find((s) => s.id === 'home1').remote, 'HOME');
  assert.equal(Math.round(m.totals.cost * 100) / 100, 7);
});

test('a work session continued on the home laptop from the drive keeps who-paid-what', () => {
  const drive = tmp('engram-usb-');
  const workDir = path.join(tmp('engram-w-'), '.claude');
  const homeDir = path.join(tmp('engram-h-'), '.claude');
  const homeRepo = tmp('engram-repo-');
  writeSession(workDir, 'w', 'x', transcript({ sessionId: 'x', cwd: '/work/app', turns: [{ prompt: 'start', usage: U(1_000_000, 0) }] }));
  plugInto(drive, 'work', workDir).scan();

  const home = plugInto(drive, 'home', homeDir);
  const s = home.scan().sessions.find((q) => q.id === 'x');
  assert.equal(s.remote, 'WORK');
  const homeAcct = home.store.data.accounts.find((a) => a.machineId === 'home');
  const dest = sync.bringHere(home.store, { file: s.file, sessionId: 'x', remotePath: s.projectPath, localPath: homeRepo, account: homeAcct, sourceAccountId: s.accountId });
  fs.appendFileSync(dest, transcript({ sessionId: 'x', cwd: homeRepo, turns: [{ prompt: 'more', usage: U(2_000_000, 0) }] }).replace(/msg_x_0/g, 'msg_x_h').replace(/req_0/g, 'req_h'));

  let m = home.scan();
  assert.equal(m.totals.sessions, 1);
  assert.equal(m.accounts.find((a) => a.id === homeAcct.id).cost, 4, 'home paid for its continuation');
  assert.equal(m.accounts.find((a) => a.remote).cost, 2, 'work keeps the original turn');

  // Back at work: the continuation made on the home laptop is visible and credited to home.
  const work = plugInto(drive, 'work', workDir);
  m = work.scan();
  assert.equal(Math.round(m.totals.cost * 100) / 100, 6);
  assert.equal(m.accounts.find((a) => !a.remote).cost, 2);
  assert.equal(m.accounts.find((a) => a.remote).cost, 4);
  assert.ok(fs.statSync(path.join(drive, 'ENGRAM-data', 'vault', 'recordings', 'x.jsonl')).size > fs.statSync(path.join(workDir, 'projects', 'w', 'x.jsonl')).size, 'archive keeps the longer copy');
});
