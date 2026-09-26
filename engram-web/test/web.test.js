'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('../src/shims/fs.js');
const path = require('../src/shims/path.js');
const { setupScript, undoScript, psQuote } = require('../src/setup-script.js');

test('in-memory fs behaves like the parts of Node fs the engine uses', () => {
  fs.__reset();
  fs.__put('/claude/projects/-E-app/a.jsonl', 'x', 5);
  fs.__markLink('/claude/projects');
  assert.ok(fs.existsSync('/claude/projects'));
  assert.equal(fs.lstatSync('/claude/projects').isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync('/claude/projects'), ['-E-app']);
  const [ent] = fs.readdirSync('/claude/projects/-E-app', { withFileTypes: true });
  assert.equal(ent.name, 'a.jsonl');
  assert.equal(ent.isFile(), true);
  assert.equal(fs.statSync('/claude/projects/-E-app/a.jsonl').size, 1);
  assert.throws(() => fs.readFileSync('/nope'), /ENOENT/);

  const writes = [];
  fs.__onWrite((p, d) => writes.push([p, d]));
  fs.writeFileSync('/vault/engram.json.tmp', '{}');
  fs.renameSync('/vault/engram.json.tmp', '/vault/engram.json');
  assert.deepEqual(writes, [['/vault/engram.json', '{}']], 'only the final file is saved, not the temp');
});

test('win32 path helpers cover Windows transcript paths', () => {
  assert.equal(path.win32.isAbsolute('E:\\code\\app'), true);
  assert.equal(path.win32.relative('E:\\code\\app', 'E:\\code\\app\\src\\a.ts'), 'src\\a.ts');
  assert.equal(path.win32.relative('e:\\Code\\App', 'E:\\code\\app\\b.ts'), 'b.ts');
  assert.equal(path.join('/claude', 'projects'), '/claude/projects');
});

test('setup and undo commands are single blocks with safe quoting', () => {
  const s = setupScript("E:\\o'brien\\claude-sessions");
  assert.ok(s.startsWith('& {') && s.trim().endsWith('}'));
  assert.ok(s.includes("'E:\\o''brien\\claude-sessions'"), 'single quotes escaped');
  assert.match(s, /New-Item -ItemType Junction/);
  assert.match(s, /cleanupPeriodDays/);
  assert.ok(undoScript('E:\\claude-sessions').includes('[System.IO.Directory]::Delete($p)'));
  assert.equal(psQuote("a'b"), "'a''b'");
});
