'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sync = require('../../src/core/sync');
const { Store } = require('../../src/core/store');
const { Scanner } = require('../../src/core/scanner');
const { tmp, transcript, writeSession, U } = require('./helpers');

function gitRepo(dir, url) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
}

/** A laptop: its own home, one Claude account, a checkout of the same repo, ENGRAM vault. */
function laptop(name, shared, repoUrl) {
  const root = tmp(`engram-${name}-`);
  const repo = path.join(root, 'code', 'app');
  gitRepo(repo, repoUrl);
  const store = new Store(path.join(root, 'vault'));
  store.data.settings.sync = { folder: shared, machineName: name, codeRoots: [path.join(root, 'code')] };
  const acct = store.upsertAccount({ name: name.toUpperCase(), configDir: path.join(root, '.claude') });
  const scanner = new Scanner({ store, dataDir: path.join(root, 'vault') });
  const cycle = () => {
    const imp = sync.importMachines(store, shared);
    scanner.extraSources = imp.sources;
    const model = scanner.scan();
    sync.exportMachine(store, model, shared);
    return { model, imp };
  };
  return { root, repo, store, acct, scanner, cycle };
}

test('redact masks common secrets and keeps JSON lines valid', () => {
  const line = JSON.stringify({ text: 'key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and ghp_abcdefghijklmnopqrstuvwxyz0123456789 token Bearer abcdefghijklmnopqrstuvwxyz123 url https://bob:hunter22@db.example.com password=Sup3rS3cret! AKIAABCDEFGHIJKLMNOP' });
  const out = sync.redact(line);
  for (const s of ['sk-ant-api03', 'ghp_abc', 'abcdefghijklmnopqrstuvwxyz123', 'hunter22', 'Sup3rS3cret', 'AKIAABCDEFGHIJKLMNOP']) assert.ok(!out.includes(s), `masked ${s}`);
  assert.ok(out.includes('https://bob:[REDACTED]@db.example.com'));
  assert.doesNotThrow(() => JSON.parse(out));
  assert.equal(sync.redact('plain text, nothing secret'), 'plain text, nothing secret');
});

test('git remotes compare equal across https and ssh forms', () => {
  const a = sync.normalizeRemote('git@github.com:Nihkb007/Intune-Repository.git');
  const b = sync.normalizeRemote('https://user@github.com/nihkb007/Intune-Repository');
  assert.equal(a, 'github.com/nihkb007/intune-repository');
  assert.equal(a, b);
});

test('Claude project slugs replace every non-alphanumeric character', () => {
  assert.equal(sync.slugFor('C:\\Users\\me\\code\\my.app'), 'C--Users-me-code-my-app');
  assert.equal(sync.slugFor('/home/me/code/app'), '-home-me-code-app');
});

test('two laptops see each other\'s sessions, grouped as one project, costs not mixed', () => {
  const shared = tmp('engram-shared-');
  const work = laptop('work', shared, 'git@github.com:me/app.git');
  const home = laptop('home', shared, 'https://github.com/me/app');
  writeSession(work.acct.configDir, 'w', 'ws1', transcript({ sessionId: 'ws1', cwd: work.repo, turns: [{ prompt: 'work task', model: 'claude-sonnet-5', usage: U(1_000_000, 0), tools: [{ name: 'Bash', input: { command: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }] }] }));
  writeSession(home.acct.configDir, 'h', 'hs1', transcript({ sessionId: 'hs1', cwd: home.repo, turns: [{ prompt: 'home task', model: 'claude-opus-5', usage: U(1_000_000, 0) }] }));

  work.cycle();
  const { model, imp } = home.cycle();
  assert.equal(imp.machines.length, 1);
  assert.equal(imp.machines[0].name, 'work');
  assert.equal(model.totals.sessions, 2);
  assert.equal(Math.round(model.totals.cost * 100) / 100, 7);
  assert.equal(model.projects.length, 1, 'same repo at different paths is one project');
  assert.equal(model.projects[0].key, 'git:github.com/me/app');
  assert.equal(model.projects[0].localPath, home.repo);
  const remoteAcct = model.accounts.find((a) => a.remote);
  assert.equal(remoteAcct.name, 'WORK @ work');
  assert.equal(remoteAcct.cost, 2);
  assert.equal(model.accounts.find((a) => a.id === home.acct.id).cost, 5);
  assert.equal(model.sessions.find((s) => s.id === 'ws1').remote, 'work');

  const exported = fs.readFileSync(path.join(shared, 'ENGRAM-sync', 'machines', work.store.data.settings.sync.machineId, 'sessions', 'ws1.jsonl'), 'utf8');
  assert.ok(!exported.includes('ghp_abcdef'), 'secrets are masked in synced transcripts');
});

test('notes merge both ways, newest edit wins, deletions propagate', () => {
  const shared = tmp('engram-shared-');
  const a = laptop('a', shared, 'git@github.com:me/app.git');
  const b = laptop('b', shared, 'git@github.com:me/app.git');
  const n = a.store.upsertNote({ title: 'Use integer cents', body: 'v1', scope: 'global', kind: 'directive' });
  a.cycle(); b.cycle();
  assert.equal(b.store.data.notes.find((x) => x.id === n.id).body, 'v1');

  const later = new Date(Date.now() + 5000).toISOString();
  b.store.data.notes.find((x) => x.id === n.id).body = 'v2';
  b.store.data.notes.find((x) => x.id === n.id).updatedAt = later;
  b.cycle(); a.cycle();
  assert.equal(a.store.data.notes.find((x) => x.id === n.id).body, 'v2', 'newer edit from b wins on a');

  a.store.data.tombstones[n.id] = new Date(Date.now() + 10000).toISOString();
  a.store.data.notes = a.store.data.notes.filter((x) => x.id !== n.id);
  a.cycle(); b.cycle();
  assert.ok(!b.store.data.notes.some((x) => x.id === n.id), 'deletion reaches b');
  a.cycle();
  assert.ok(!a.store.data.notes.some((x) => x.id === n.id), 'and is not resurrected on a');
});

test('memory-only mode and project selection limit what leaves the laptop', () => {
  const shared = tmp('engram-shared-');
  const work = laptop('work', shared, 'git@github.com:corp/secret.git');
  const home = laptop('home', shared, 'git@github.com:me/app.git');
  writeSession(work.acct.configDir, 'w', 'w1', transcript({ sessionId: 'w1', cwd: work.repo, turns: [{ prompt: 'x', usage: U(10, 10) }] }));
  work.store.data.settings.sync.projects = []; // share no projects
  work.cycle();
  assert.equal(home.cycle().model.totals.sessions, 0);
  work.store.data.settings.sync.projects = null; // all
  work.store.data.settings.sync.mode = 'memory';
  work.cycle();
  assert.equal(home.cycle().model.totals.sessions, 0, 'memory mode shares no sessions');
  work.store.data.settings.sync.mode = 'full';
  work.cycle();
  assert.equal(home.cycle().model.totals.sessions, 1);
});

test('bring a session to the other laptop, continue it there, both laptops agree on who paid', () => {
  const shared = tmp('engram-shared-');
  const work = laptop('work', shared, 'git@github.com:me/app.git');
  const home = laptop('home', shared, 'git@github.com:me/app.git');
  writeSession(work.acct.configDir, 'w', 'x', transcript({ sessionId: 'x', cwd: work.repo, turns: [{ prompt: 'start', usage: U(1_000_000, 0) }] }));
  work.cycle();
  const { model } = home.cycle();
  const s = model.sessions.find((q) => q.id === 'x');
  const proj = model.projects.find((p) => p.key === s.projectKey);

  const dest = sync.bringHere(home.store, { file: s.file, sessionId: 'x', remotePath: s.projectPath, localPath: proj.localPath, account: home.acct, machineId: work.store.data.settings.sync.machineId });
  assert.equal(path.basename(path.dirname(dest)), sync.slugFor(home.repo));
  const first = JSON.parse(fs.readFileSync(dest, 'utf8').split('\n').find((l) => l.includes('"cwd"')));
  assert.equal(first.cwd, home.repo, 'cwd rewritten to this laptop\'s checkout');

  // Continue on the home laptop.
  fs.appendFileSync(dest, transcript({ sessionId: 'x', cwd: home.repo, turns: [{ prompt: 'more', usage: U(2_000_000, 0) }] }).replace(/msg_x_0/g, 'msg_x_home').replace(/req_0/g, 'req_home'));

  const h = home.cycle().model;
  assert.equal(h.totals.sessions, 1);
  assert.equal(h.accounts.find((a) => a.id === home.acct.id).cost, 4, 'home paid for its turn');
  assert.equal(h.accounts.find((a) => a.remote).cost, 2, 'work paid for the original turn');
  assert.equal(h.sessions[0].remote, null, 'now a local session on home');

  const w = work.cycle().model;
  assert.equal(w.totals.sessions, 1);
  assert.equal(Math.round(w.totals.cost * 100) / 100, 6, 'no double counting on work');
  assert.equal(w.accounts.find((a) => a.id === work.acct.id).cost, 2);
  assert.equal(w.accounts.find((a) => a.remote).cost, 4);

  // Work also continues its own copy -> the copies diverge; bringing again must refuse.
  fs.appendFileSync(path.join(work.acct.configDir, 'projects', 'w', 'x.jsonl'), transcript({ sessionId: 'x', cwd: work.repo, turns: [{ prompt: 'w2', usage: U(1, 1) }] }).replace(/msg_x_0/g, 'msg_x_w2').replace(/req_0/g, 'req_w2'));
  work.cycle();
  const again = home.cycle().model.sessions.find((q) => q.id === 'x');
  const remoteFile = path.join(shared, 'ENGRAM-sync', 'machines', work.store.data.settings.sync.machineId, 'sessions', 'x.jsonl');
  assert.throws(() => sync.bringHere(home.store, { file: remoteFile, sessionId: 'x', remotePath: work.repo, localPath: home.repo, account: home.acct }), /diverged/);
  assert.ok(again);
});
