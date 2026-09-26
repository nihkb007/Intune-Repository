'use strict';
// LINK: share ENGRAM between laptops through any folder both can reach (OneDrive, Dropbox,
// Google Drive, Syncthing, a network share, a USB stick). Each laptop writes only its own
// sub-folder, so the sync service never sees two writers on one file:
//
//   <folder>/ENGRAM-sync/machines/<machineId>/
//       machine.json     name, accounts, projects (+ git remotes), last push
//       vault.json       notes (+ deletion tombstones) and capsules
//       sessions/index.json, sessions/<sessionId>.jsonl   (secrets masked)
//
// Every laptop reads the others' folders: their notes and capsules merge into the local
// vault (newest edit wins), and their sessions appear as read-only "remote" accounts in
// the analytics. A remote session can be brought to this laptop to resume it here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { parseTranscript } = require('./transcripts');

const ROOT = 'ENGRAM-sync';
const REMOTE_COLORS = ['#fcee0a', '#3dff9a', '#ff8a3d', '#8b7bff', '#ff2bd6', '#00f0ff'];

// ---------------------------------------------------------------------------------------
// helpers

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Write via temp + rename so a sync client never uploads a half-written file. */
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.partial`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /(?<=[Bb]earer\s)[A-Za-z0-9._~+/-]{20,}=*/g,
  /(?<=:\/\/[^\s:/@"]{1,64}:)[^\s@/"]{3,}(?=@)/g, // passwords in URLs
  /(?<=(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*)[^\s"'\\,;]{6,}/gi,
];

/** Mask credentials in text. Replacement contains no quotes/backslashes, so JSON stays valid. */
function redact(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** Normalise a git remote so https / ssh forms of the same repo compare equal. */
function normalizeRemote(url) {
  if (!url) return null;
  let u = String(url).trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const scp = u.match(/^[^@\s]+@([^:\s]+):(.+)$/); // git@github.com:owner/repo
  if (scp) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, ''); // scheme and user@
  return u.toLowerCase();
}

const remoteCache = new Map();
/** origin remote of the repo containing dir (walks up to find .git), or null. */
function gitRemote(dir) {
  if (!dir) return null;
  if (remoteCache.has(dir)) return remoteCache.get(dir);
  let result = null;
  let cur = dir;
  for (let i = 0; i < 12 && cur; i++) {
    const cfg = path.join(cur, '.git', 'config');
    if (fs.existsSync(cfg)) {
      const text = fs.readFileSync(cfg, 'utf8');
      const m = text.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/) || text.match(/\[remote "[^"]+"\][^[]*?url\s*=\s*(\S+)/);
      result = m ? normalizeRemote(m[1]) : null;
      break;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  remoteCache.set(dir, result);
  return result;
}

const DEFAULT_CODE_ROOTS = ['code', 'src', 'source/repos', 'repos', 'projects', 'dev', 'git', 'Documents/GitHub', 'Documents/code', 'Desktop'];

/** Folders to search for local checkouts: settings + common locations under the home folder. */
function codeRoots(store, home = os.homedir()) {
  const extra = store.data.settings.sync?.codeRoots || [];
  return [...extra, ...DEFAULT_CODE_ROOTS.map((d) => path.join(home, d))].filter((d) => fs.existsSync(d));
}

/** Find git checkouts under roots (depth-limited). Returns Map(normalizedRemote -> path). */
function findCheckouts(roots, maxDepth = 3) {
  const found = new Map();
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'bin', 'obj', '.venv', 'venv', 'AppData', 'Library']);
  const walk = (dir, depth) => {
    if (fs.existsSync(path.join(dir, '.git'))) {
      const r = gitRemote(dir);
      if (r && !found.has(r)) found.set(r, dir);
      return;
    }
    if (depth >= maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return found;
}

/** Claude Code stores a project's sessions under projects/<path with non-alphanumerics as '-'>. */
function slugFor(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Who is this laptop? Derived from the computer, never stored in the vault, because the
 * vault itself may travel between laptops on a thumb drive. Order: in-memory override
 * (tests), explicit settings id (demo data), then a hash of host + user name.
 */
function identity(store) {
  const s = store.data.settings;
  s.sync = s.sync || {};
  let host = 'laptop';
  let user = '';
  try { host = os.hostname() || host; user = os.userInfo().username || ''; } catch { /* restricted env */ }
  const id = store.machineOverride?.id || process.env.ENGRAM_MACHINE_ID || s.sync.machineId || 'm_' + crypto.createHash('sha1').update(`${host.toLowerCase()}|${user.toLowerCase()}`).digest('hex').slice(0, 10);
  const name = store.data.machines?.[id]?.name || store.machineOverride?.name || s.sync.machineName || host;
  return { id, name };
}

/**
 * Called at startup on every laptop. Registers the laptop, claims accounts from before
 * laptops were tracked, and links this laptop's Claude accounts the first time it runs.
 */
function adoptThisMachine(store, detected = []) {
  const me = identity(store);
  const machines = (store.data.machines = store.data.machines || {});
  const first = !machines[me.id];
  machines[me.id] = { ...(machines[me.id] || {}), name: machines[me.id]?.name || me.name, platform: process.platform, lastSeen: new Date().toISOString() };
  for (const a of store.data.accounts) if (!a.machineId) a.machineId = me.id;
  const mine = store.data.accounts.filter((a) => a.machineId === me.id);
  if (first && !mine.length) {
    for (const d of detected) {
      const a = store.upsertAccount({ ...d });
      a.machineId = me.id;
    }
  }
  // The active account must be one that exists on this laptop.
  const local = store.data.accounts.filter((a) => a.machineId === me.id);
  if (!local.some((a) => a.id === store.data.activeAccountId)) store.data.activeAccountId = local[0]?.id || null;
  store.save(true);
  return { me, first, accounts: local };
}

function localAccounts(store) {
  const { id } = identity(store);
  return store.data.accounts.filter((a) => !a.machineId || a.machineId === id);
}

function syncRoot(folder) {
  return path.join(folder, ROOT, 'machines');
}

// ---------------------------------------------------------------------------------------
// export (this laptop → folder)

/**
 * @param store    ENGRAM store
 * @param model    scanner.model after a scan (local sessions carry .file, .projectPath)
 * @param folder   shared folder
 */
function exportMachine(store, model, folder) {
  const me = identity(store);
  const cfg = store.data.settings.sync;
  const dir = path.join(syncRoot(folder), me.id);
  const sessDir = path.join(dir, 'sessions');
  const state = (store.data.syncState = store.data.syncState || { exported: {}, imported: {} });
  state.exported = state.exported || {};
  state.imported = state.imported || {};
  const share = (p) => !Array.isArray(cfg.projects) || cfg.projects.includes(p);

  const localProjects = model.projects.filter((p) => p.localPath);
  writeAtomic(path.join(dir, 'machine.json'), JSON.stringify({
    id: me.id,
    name: me.name,
    platform: process.platform,
    pushedAt: new Date().toISOString(),
    mode: cfg.mode || 'full',
    accounts: localAccounts(store).map((a) => ({ id: a.id, name: a.name, color: a.color, email: a.email })),
    projects: localProjects.filter((p) => share(p.key)).map((p) => ({ key: p.key, name: p.name, path: p.localPath, remote: p.remote })),
  }, null, 2));

  const notes = store.data.notes.filter((n) => n.scope === 'global' || !n.project || share(n.project));
  writeAtomic(path.join(dir, 'vault.json'), JSON.stringify({ notes, tombstones: store.data.tombstones || {}, capsules: store.data.capsules.map((c) => ({ ...c, markdown: redact(c.markdown) })) }));

  let written = 0;
  const index = {};
  if ((cfg.mode || 'full') === 'full') {
    for (const s of model.sessions) {
      if (s.remote || !s.localAccountId || !share(s.projectKey)) continue;
      const file = s.file;
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file);
      const dest = path.join(sessDir, `${s.id}.jsonl`);
      index[s.id] = {
        accountId: s.localAccountId,
        projectKey: s.projectKey,
        projectPath: s.projectPath,
        remote: s.gitRemote || gitRemote(s.projectPath),
        size: st.size,
        // Messages this laptop received from another laptop: importers must not credit them here.
        foreign: state.imported[s.id]?.keys || [],
      };
      const prev = state.exported[s.id];
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && fs.existsSync(dest)) continue;
      writeAtomic(dest, redact(fs.readFileSync(file, 'utf8')));
      state.exported[s.id] = { size: st.size, mtimeMs: st.mtimeMs };
      written++;
    }
  }
  // Remove sessions no longer shared (project unticked, or mode switched to memory-only).
  if (fs.existsSync(sessDir)) {
    for (const f of fs.readdirSync(sessDir)) {
      const sid = f.replace(/\.jsonl$/, '');
      if (f.endsWith('.jsonl') && !index[sid]) { fs.rmSync(path.join(sessDir, f), { force: true }); delete state.exported[sid]; }
    }
  }
  writeAtomic(path.join(sessDir, 'index.json'), JSON.stringify(index));
  cfg.lastPush = new Date().toISOString();
  store.save();
  return { machine: me, sessions: Object.keys(index).length, written, notes: notes.length };
}

// ---------------------------------------------------------------------------------------
// import (folder → this laptop)

function mergeVault(store, remote) {
  let changed = 0;
  const tomb = (store.data.tombstones = store.data.tombstones || {});
  for (const [id, ts] of Object.entries(remote.tombstones || {})) {
    if (!tomb[id] || tomb[id] < ts) tomb[id] = ts;
  }
  const byId = new Map(store.data.notes.map((n) => [n.id, n]));
  for (const n of remote.notes || []) {
    if (tomb[n.id] && tomb[n.id] >= n.updatedAt) continue;
    const mine = byId.get(n.id);
    if (!mine || mine.updatedAt < n.updatedAt) { byId.set(n.id, n); changed++; }
  }
  for (const [id, ts] of Object.entries(tomb)) {
    const n = byId.get(id);
    if (n && n.updatedAt <= ts) { byId.delete(id); changed++; }
  }
  store.data.notes = [...byId.values()];
  const caps = new Map(store.data.capsules.map((c) => [c.id, c]));
  for (const c of remote.capsules || []) if (!caps.has(c.id) && !tomb[c.id]) { caps.set(c.id, c); changed++; }
  store.data.capsules = [...caps.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 200);
  return changed;
}

/**
 * Reads every other laptop's folder. Merges their vaults into the store and returns
 * scanner sources for their sessions.
 */
function importMachines(store, folder) {
  const me = identity(store);
  const root = syncRoot(folder);
  const machines = [];
  const sources = [];
  let merged = 0;
  if (!fs.existsSync(root)) return { machines, sources, merged };
  let colorIdx = 0;
  for (const mid of fs.readdirSync(root)) {
    if (mid === me.id) continue;
    const dir = path.join(root, mid);
    const info = readJSON(path.join(dir, 'machine.json'));
    if (!info) continue;
    const vault = readJSON(path.join(dir, 'vault.json'));
    if (vault) merged += mergeVault(store, vault);
    const index = readJSON(path.join(dir, 'sessions', 'index.json'), {});
    const accounts = new Map();
    for (const a of info.accounts || []) {
      accounts.set(a.id, {
        id: `${mid}:${a.id}`,
        name: `${a.name} @ ${info.name}`,
        color: REMOTE_COLORS[colorIdx++ % REMOTE_COLORS.length],
        email: a.email || null,
        remote: true,
        machine: info.name,
        machineId: mid,
      });
    }
    for (const acct of accounts.values()) {
      const files = [];
      const foreign = {};
      for (const [sid, e] of Object.entries(index)) {
        if (`${mid}:${e.accountId}` !== acct.id) continue;
        const file = path.join(dir, 'sessions', `${sid}.jsonl`);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        files.push({ file, slug: null, size: st.size, mtimeMs: st.mtimeMs, nested: false, projectKey: e.projectKey, projectPath: e.projectPath, gitRemote: e.remote });
        if (e.foreign && e.foreign.length) foreign[sid] = new Set(e.foreign);
      }
      sources.push({ account: acct, files, foreign });
    }
    machines.push({ id: mid, name: info.name, platform: info.platform, pushedAt: info.pushedAt, mode: info.mode, accounts: [...accounts.values()], projects: info.projects || [], sessions: Object.keys(index).length });
  }
  store.data.settings.sync.lastPull = new Date().toISOString();
  store.save();
  return { machines, sources, merged };
}

// ---------------------------------------------------------------------------------------
// bring a remote session to this laptop

/**
 * Copies a remote session into a local account so `claude --resume <id>` works here.
 * cwd fields are rewritten from the other laptop's project path to localPath.
 */
function bringHere(store, { file, sessionId, remotePath, localPath, account, machineId, sourceAccountId }) {
  if (!localPath || !fs.existsSync(localPath)) throw new Error(`Project folder not found on this laptop: ${localPath || '(none)'}`);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').map((line) => {
    if (!line.trim()) return line;
    try {
      const e = JSON.parse(line);
      if (typeof e.cwd === 'string' && remotePath && (e.cwd === remotePath || e.cwd.startsWith(remotePath))) {
        e.cwd = localPath + e.cwd.slice(remotePath.length);
      } else if (typeof e.cwd === 'string') {
        e.cwd = localPath;
      }
      return JSON.stringify(e);
    } catch { return line; }
  });
  const incomingKeys = parseTranscript(text).usageEntries.map((u) => u.key);

  // Prefer the slug Claude Code already uses for this folder on this account.
  const projRoot = path.join(account.configDir, 'projects');
  let slug = slugFor(localPath);
  if (fs.existsSync(projRoot)) {
    for (const d of fs.readdirSync(projRoot)) {
      if (d.toLowerCase() === slug.toLowerCase()) { slug = d; break; }
    }
  }
  const dest = path.join(projRoot, slug, `${sessionId}.jsonl`);
  if (fs.existsSync(dest)) {
    const localKeys = parseTranscript(fs.readFileSync(dest, 'utf8')).usageEntries.map((u) => u.key);
    const incoming = new Set(incomingKeys);
    if (localKeys.some((k) => !incoming.has(k))) {
      throw new Error('This session was continued on both laptops, so the copies have diverged. Resume the local copy, or fuse both into a capsule.');
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, lines.join('\n'));
  const state = (store.data.syncState = store.data.syncState || { exported: {}, imported: {} });
  state.imported = state.imported || {};
  state.imported[sessionId] = { machineId, accountId: sourceAccountId || null, keys: incomingKeys, at: new Date().toISOString() };
  store.save(true);
  return dest;
}

module.exports = { adoptThisMachine, localAccounts, codeRoots, findCheckouts, redact, normalizeRemote, gitRemote, slugFor, identity, exportMachine, importMachines, mergeVault, bringHere, ROOT };
