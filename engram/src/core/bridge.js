'use strict';
// BRIDGE: makes multiple Claude accounts share one memory.
//  - Account discovery: every Claude Code config dir (~/.claude, ~/.claude-*, $CLAUDE_CONFIG_DIR).
//  - Session bridge: mirrors transcripts between accounts so `claude --resume <id>` works on
//    whichever account you are signed into. The largest (most complete) copy wins.
//  - Memory sync: writes ENGRAM's global directives into each account's user CLAUDE.md
//    inside a managed block, leaving the rest of the file untouched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { listTranscriptFiles, parseTranscript } = require('./transcripts');
const { injectManagedBlock } = require('./fusion');

const PALETTE = ['#00f0ff', '#ff2bd6', '#fcee0a', '#8b7bff', '#3dff9a'];

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Profile info Claude Code keeps next to a config dir. Only non-secret fields are read. */
function readProfile(configDir, home = os.homedir()) {
  const defaultDir = path.join(home, '.claude');
  const candidates = [path.join(configDir, '.claude.json')];
  if (path.resolve(configDir) === path.resolve(defaultDir)) candidates.push(path.join(home, '.claude.json'));
  for (const c of candidates) {
    const j = readJSON(c);
    const o = j && j.oauthAccount;
    if (o) return { email: o.emailAddress || null, org: o.organizationName || null, plan: o.billingType || null };
  }
  return { email: null, org: null, plan: null };
}

function detectAccounts({ home = os.homedir(), env = process.env } = {}) {
  const dirs = new Set();
  const add = (d) => { if (d && fs.existsSync(d)) dirs.add(path.resolve(d)); };
  add(path.join(home, '.claude'));
  if (env.CLAUDE_CONFIG_DIR) add(env.CLAUDE_CONFIG_DIR);
  try {
    for (const ent of fs.readdirSync(home, { withFileTypes: true })) {
      if (ent.isDirectory() && /^\.claude[-_.]/.test(ent.name)) add(path.join(home, ent.name));
    }
  } catch { /* unreadable home */ }
  return [...dirs]
    .filter((d) => fs.existsSync(path.join(d, 'projects')) || fs.existsSync(path.join(d, '.claude.json')) || fs.existsSync(path.join(d, 'settings.json')))
    .map((configDir, i) => {
      const prof = readProfile(configDir, home);
      const base = path.basename(configDir).replace(/^\.claude[-_.]?/, '') || 'primary';
      return {
        name: prof.email ? prof.email.split('@')[0] : base.toUpperCase(),
        configDir,
        email: prof.email,
        plan: prof.plan,
        color: PALETTE[i % PALETTE.length],
      };
    });
}

function msgKeys(file) {
  try {
    const { usageEntries } = parseTranscript(fs.readFileSync(file, 'utf8'));
    return usageEntries.map((u) => u.key);
  } catch { return []; }
}

/**
 * Mirror every session (or just `only`: [sessionId]) into every account.
 * Returns { plan: [{sessionId, from, to, dest, reason}], copied, ledger }.
 * ledger[sessionId] = { origin, copies: [paths], attrib: { key: accountId } }
 */
function syncSessions(accounts, ledger = {}, { dryRun = false, only = null } = {}) {
  const instances = new Map(); // sessionId -> [{account, file, slug, size, mtimeMs}]
  for (const a of accounts) {
    for (const f of listTranscriptFiles(a.configDir)) {
      if (f.nested) continue;
      const sid = path.basename(f.file, '.jsonl');
      if (only && !only.includes(sid)) continue;
      if (!instances.has(sid)) instances.set(sid, []);
      instances.get(sid).push({ account: a, ...f });
    }
  }
  const plan = [];
  let copied = 0;
  const next = JSON.parse(JSON.stringify(ledger));

  for (const [sid, list] of instances) {
    const canonical = [...list].sort((x, y) => (y.size - x.size) || (y.mtimeMs - x.mtimeMs))[0];
    const entry = next[sid] || { origin: list.find((i) => !(ledger[sid]?.copies || []).includes(i.file))?.account.id || canonical.account.id, copies: [], attrib: {} };
    entry.attrib = entry.attrib || {};

    // Messages that exist in the canonical copy but in no other copy were produced on the
    // canonical's account. Remember that before we overwrite the others.
    if (list.length > 1 && !dryRun) {
      const others = new Set(list.filter((i) => i !== canonical).flatMap((i) => msgKeys(i.file)));
      for (const k of msgKeys(canonical.file)) {
        if (!others.has(k) && !entry.attrib[k] && canonical.account.id !== entry.origin) entry.attrib[k] = canonical.account.id;
      }
    }

    for (const a of accounts) {
      const have = list.find((i) => i.account.id === a.id);
      const dest = have ? have.file : path.join(a.configDir, 'projects', canonical.slug, `${sid}.jsonl`);
      let reason = null;
      if (!have) reason = 'missing';
      else if (have.size < canonical.size) reason = 'behind';
      if (!reason) continue;
      plan.push({ sessionId: sid, from: canonical.account.id, to: a.id, dest, reason, bytes: canonical.size });
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(canonical.file, dest);
        copied++;
      }
      if (a.id !== entry.origin && !entry.copies.includes(dest)) entry.copies.push(dest);
    }
    if (list.length > 1 || plan.some((p) => p.sessionId === sid)) next[sid] = entry;
  }
  return { plan, copied, ledger: dryRun ? ledger : next };
}

/** Write global directives into each account's user-level CLAUDE.md managed block. */
function syncMemory(accounts, markdown, { dryRun = false } = {}) {
  const results = [];
  for (const a of accounts) {
    const file = path.join(a.configDir, 'CLAUDE.md');
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const after = injectManagedBlock(before, markdown);
    results.push({ accountId: a.id, file, changed: before !== after });
    if (!dryRun && before !== after) {
      fs.mkdirSync(a.configDir, { recursive: true });
      fs.writeFileSync(file, after);
    }
  }
  return results;
}

/** Write a capsule into <project>/CLAUDE.md — shared by every account that opens the project. */
function injectProject(projectPath, markdown) {
  if (!projectPath || !fs.existsSync(projectPath)) throw new Error(`Project folder not found: ${projectPath}`);
  const file = path.join(projectPath, 'CLAUDE.md');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, injectManagedBlock(before, markdown));
  return file;
}

function isDefaultDir(configDir, home = os.homedir()) {
  return path.resolve(configDir) === path.resolve(path.join(home, '.claude'));
}

function launchCommand(account, { projectPath, resumeId, platform = process.platform, home } = {}) {
  const needsEnv = account && !isDefaultDir(account.configDir, home);
  const claude = `claude${resumeId ? ` --resume ${resumeId}` : ''}`;
  if (platform === 'win32') {
    const parts = [];
    if (projectPath) parts.push(`Set-Location -LiteralPath '${projectPath.replace(/'/g, "''")}'`);
    if (needsEnv) parts.push(`$env:CLAUDE_CONFIG_DIR='${account.configDir.replace(/'/g, "''")}'`);
    parts.push(claude);
    return parts.join('; ');
  }
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [];
  if (projectPath) parts.push(`cd ${q(projectPath)}`);
  parts.push(`${needsEnv ? `CLAUDE_CONFIG_DIR=${q(account.configDir)} ` : ''}${claude}`);
  return parts.join(' && ');
}

/** Open a terminal running Claude Code on the given account. */
function launchTerminal(account, opts = {}) {
  const platform = process.platform;
  const cmd = launchCommand(account, { ...opts, platform });
  if (platform === 'win32') {
    // detached gives a console app its own window on Windows; no cmd.exe quoting involved.
    spawn('powershell.exe', ['-NoExit', '-NoLogo', '-Command', cmd], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } else if (platform === 'darwin') {
    const script = `tell application "Terminal" to do script ${JSON.stringify(cmd)}`;
    spawn('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].find((t) => {
      try { require('child_process').execSync(`command -v ${t}`, { stdio: 'ignore' }); return true; } catch { return false; }
    });
    if (!term) throw new Error('No terminal emulator found. Copy the launch command instead.');
    const args = term === 'gnome-terminal' ? ['--', 'bash', '-lc', `${cmd}; exec bash`] : ['-e', 'bash', '-lc', `${cmd}; exec bash`];
    spawn(term, args, { detached: true, stdio: 'ignore' }).unref();
  }
  return cmd;
}

module.exports = { detectAccounts, readProfile, syncSessions, syncMemory, injectProject, launchCommand, launchTerminal, isDefaultDir };
