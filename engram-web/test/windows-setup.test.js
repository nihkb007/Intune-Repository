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
    // .native expands Windows 8.3 short names (RUNNER~1) so both sides compare as long paths.
    assert.equal(fs.realpathSync.native(link).toLowerCase(), fs.realpathSync.native(drive).toLowerCase());
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

for (const sh of shells) {
  test(`a session file held open by another app stops setup safely and is named (${sh})`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ps-lock-'));
    const claude = path.join(root, 'laptop', '.claude');
    const drive = path.join(root, 'drive', 'claude-sessions');
    const locked = path.join(claude, 'projects', 'E--code-app', 'busy.jsonl');
    fs.mkdirSync(path.dirname(locked), { recursive: true });
    fs.writeFileSync(locked, '{"a":1}\n');
    // Hold the file open with no sharing (like a running Claude app) while setup runs.
    const script = `$h = [System.IO.File]::Open('${locked.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'None')\n${setupScript(drive, { claudeDir: claude })}\n$h.Close()`;
    const out = run(sh, script);
    assert.match(out, /Some files could not be copied/);
    assert.match(out, /busy\.jsonl/, 'the blocked file is named');
    assert.match(out, /close Claude Code/);
    assert.ok(!fs.lstatSync(path.join(claude, 'projects')).isSymbolicLink(), 'nothing changed on the laptop');
    assert.match(run(sh, setupScript(drive, { claudeDir: claude })), /Done: Claude Code sessions now live on/, 'works once the file is closed');
  });
}

for (const sh of shells) {
  test(`setup checks free space before copying (${sh})`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ps-space-'));
    const claude = path.join(root, 'laptop', '.claude');
    fs.mkdirSync(path.join(claude, 'projects', 'E--code-app'), { recursive: true });
    fs.writeFileSync(path.join(claude, 'projects', 'E--code-app', 's1.jsonl'), '{"a":1}\n');
    // Pretend the drive is almost full: Get-Volume reports 1 byte free.
    const fake = 'function Get-Volume { [pscustomobject]@{ SizeRemaining = 1; FileSystem = "NTFS" } }';
    const out = run(sh, `${fake}\n${setupScript(path.join(root, 'drive', 'claude-sessions'), { claudeDir: claude })}`);
    assert.match(out, /Not enough space on [A-Z]: 0\.0 GB needed, 0\.0 GB free/);
    assert.ok(!fs.lstatSync(path.join(claude, 'projects')).isSymbolicLink(), 'nothing changed');
  });
}

test('windows setup test ran or was skipped off Windows', () => {
  assert.ok(process.platform !== 'win32' || shells.length > 0, 'expected PowerShell on Windows');
});
