'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../../src/core/store');
const { tmp } = require('./helpers');

test('notes persist across restarts, sorted pinned first', () => {
  const dir = tmp();
  const s = new Store(dir);
  const a = s.upsertNote({ title: 'a', body: 'x', project: '/p' });
  s.upsertNote({ title: 'b', body: 'y', pinned: true, kind: 'directive', scope: 'global' });
  s.upsertNote({ id: a.id, title: 'a2' });
  s.save(true);
  const s2 = new Store(dir);
  assert.deepEqual(s2.listNotes().map((n) => n.title), ['b', 'a2']);
  assert.deepEqual(s2.listNotes({ project: '/p' }).map((n) => n.title), ['b', 'a2'], 'global notes show in every project');
  assert.deepEqual(s2.listNotes({ q: 'A2' }).map((n) => n.title), ['a2']);
  assert.equal(s2.deleteNote(a.id), true);
  assert.equal(s2.listNotes().length, 1);
});

test('invalid note fields are sanitised', () => {
  const s = new Store(tmp());
  const n = s.upsertNote({ title: 'x'.repeat(500), kind: 'evil', scope: 'weird', tags: 'nope' });
  assert.equal(n.title.length, 200);
  assert.equal(n.kind, 'note');
  assert.equal(n.scope, 'project');
  assert.deepEqual(n.tags, []);
});

test('a corrupt vault is backed up, not silently lost', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'engram.json'), '{ not json');
  const s = new Store(dir);
  assert.deepEqual(s.data.notes, []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('engram.json.corrupt-')));
});

test('accounts: first becomes active, removal reassigns active', () => {
  const s = new Store(tmp());
  const a = s.upsertAccount({ name: 'A', configDir: '/a', color: 'red' });
  const b = s.upsertAccount({ name: 'B', configDir: '/b', color: '#ff00ff' });
  assert.equal(s.data.activeAccountId, a.id);
  assert.equal(a.color, '#00f0ff', 'invalid color replaced');
  assert.equal(b.color, '#ff00ff');
  s.removeAccount(a.id);
  assert.equal(s.data.activeAccountId, b.id);
});

test('partial updates keep fields that were not sent', () => {
  const s = new Store(tmp());
  const n = s.upsertNote({ title: 't', body: 'b', project: '/p', kind: 'lesson', tags: ['x'] });
  const u = s.upsertNote({ id: n.id, pinned: true });
  assert.deepEqual([u.title, u.body, u.project, u.kind, u.tags, u.pinned], ['t', 'b', '/p', 'lesson', ['x'], true]);
  const a = s.upsertAccount({ name: 'A', configDir: '/a', color: '#123456' });
  const a2 = s.upsertAccount({ id: a.id, name: 'Renamed' });
  assert.deepEqual([a2.name, a2.configDir, a2.color], ['Renamed', '/a', '#123456']);
});
