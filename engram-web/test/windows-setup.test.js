'use strict';
// Runs the website's PowerShell setup/undo commands for real. Windows only (CI runs it on
// a Windows runner, in both Windows PowerShell 5.1 and PowerShell 7).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { setupScript, undoScript } = require('../src/setup-script.js');

const shells = process.platform === 'win32'
  ? ['powershell.exe', 'pwsh.exe'].filter((sh) => { try { execFileSync(sh, ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); return true; } catch { return false; } })
  : [];

const run = (sh, script) => execFileSync(sh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });

for (const sh of shells) {
  test(`setup, re-run and undo work in ${sh}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ps-'));
    const claude = path.join(root, 'laptop', '.claude');
    const drive = path.join(root, 'drive', 'claude-sessions');
    fs.mkdirSync(path.join(claude, 'projects', 'E--code-app'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'projects', 'E--code-app', 's1.jsonl'), '{"a":1}\n');
    fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ model: 'opus' }));

    const out1 = run(sh, setupScript(drive, { claudeDir: claude }));
    assert.match(out1, /Done: Claude Code sessions now live on/);
    const link = path.join(claude, 'projects');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'projects is now a junction');
    assert.equal(fs.realpathSync(link).toLowerCase(), fs.realpathSync(drive).toLowerCase());
    assert.equal(fs.readFileSync(path.join(drive, 'E--code-app', 's1.jsonl'), 'utf8'), '{"a":1}\n', 'existing session copied to the drive');
    assert.ok(fs.readdirSync(claude).some((n) => n.startsWith('projects.before-engram-')), 'original kept as backup');
    const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(settings.cleanupPeriodDays, 3650);
    assert.equal(settings.model, 'opus', 'other settings kept');

    // New sessions written through Claude's folder land on the drive.
    fs.writeFileSync(path.join(link, 'E--code-app', 's2.jsonl'), 'new\n');
    assert.ok(fs.existsSync(path.join(drive, 'E--code-app', 's2.jsonl')));

    assert.match(run(sh, setupScript(drive, { claudeDir: claude })), /Already set up/, 'second run is harmless');

    assert.match(run(sh, undoScript(drive, { claudeDir: claude })), /normal sessions folder again/);
    assert.ok(!fs.lstatSync(link).isSymbolicLink(), 'real folder again');
    assert.ok(fs.existsSync(path.join(link, 'E--code-app', 's2.jsonl')), 'copies restored locally');
    assert.ok(fs.existsSync(path.join(drive, 'E--code-app', 's2.jsonl')), 'drive untouched by undo');
  });
}

test('windows setup test ran or was skipped off Windows', () => {
  assert.ok(process.platform !== 'win32' || shells.length > 0, 'expected PowerShell on Windows');
});
