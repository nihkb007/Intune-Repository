'use strict';
// SESSIONS ON A DRIVE: the simple way to use the same Claude Code sessions from two
// laptops and two accounts. Each laptop's `.claude\projects` folder (where Claude Code
// saves conversations) becomes a link to `<drive>\claude-sessions`. Logins stay on each
// laptop; only the conversations live on the drive, next to the project files.
//
// Claude Code files sessions under the project's full path, so the drive must have the
// same letter on every laptop (E:\code\app must be E:\code\app everywhere). A marker file
// on the drive remembers the letter so ENGRAM can warn when it differs.

const fs = require('fs');
const path = require('path');

const FOLDER = 'claude-sessions';
const MARKER = '.engram-drive.json';

const isWin = process.platform === 'win32';
const norm = (p) => {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return isWin ? r.toLowerCase() : r;
};

function sessionsTarget(driveRoot) {
  return path.join(driveRoot, FOLDER);
}

/** "E:" for Windows roots, the root itself elsewhere. */
function letterOf(root) {
  const m = String(root).match(/^([A-Za-z]):/);
  return m ? `${m[1].toUpperCase()}:` : String(root);
}

/** Where a laptop's Claude Code keeps sessions, and whether it already points at the drive. */
function accountStatus(account, target) {
  const projects = path.join(account.configDir, 'projects');
  let st;
  try { st = fs.lstatSync(projects); } catch { return { projects, state: 'none' }; }
  if (st.isSymbolicLink()) {
    let to = null;
    try { to = fs.realpathSync(projects); } catch { /* dangling: drive not plugged in */ }
    let linkText = null;
    try { linkText = fs.readlinkSync(projects); } catch { /* unreadable */ }
    const points = to || (linkText && path.resolve(path.dirname(projects), linkText));
    if (points && norm(points) === norm(target)) return { projects, state: to ? 'shared' : 'unplugged', linkTo: points };
    return { projects, state: 'other-link', linkTo: points };
  }
  return { projects, state: st.isDirectory() ? 'local' : 'none' };
}

/** Copy every file from src into dst, keeping whichever copy of a file is larger (transcripts only grow). */
function mergeTree(src, dst) {
  let copied = 0;
  let bytes = 0;
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (e.isDirectory()) { walk(sp, dp); continue; }
      if (!e.isFile()) continue;
      const size = fs.statSync(sp).size;
      let dsize = -1;
      try { dsize = fs.statSync(dp).size; } catch { /* missing */ }
      if (size > dsize) {
        fs.copyFileSync(sp, dp);
        if (fs.statSync(dp).size !== size) throw new Error(`Copy check failed for ${dp}`);
        copied++;
        bytes += size;
      }
    }
  };
  walk(src, dst);
  return { copied, bytes };
}

function makeLink(target, linkPath) {
  if (!isWin) return fs.symlinkSync(target, linkPath, 'dir');
  // Junctions need no admin rights. If Windows refuses one, a directory symlink works when
  // Developer Mode is on or ENGRAM runs as administrator.
  try {
    fs.symlinkSync(target, linkPath, 'junction');
  } catch (err) {
    try { fs.symlinkSync(target, linkPath, 'dir'); } catch {
      throw new Error(`${err.message}. Turn on Developer Mode (Settings → System → For developers) or run ENGRAM as administrator once, then try again.`);
    }
  }
}

function removeLink(linkPath) {
  try { fs.unlinkSync(linkPath); } catch { fs.rmdirSync(linkPath); }
}

/**
 * Move one account's sessions onto the drive and link Claude Code's folder to it.
 * The original folder is kept, renamed, as a backup.
 */
function shareAccount(account, target, { now = new Date() } = {}) {
  const status = accountStatus(account, target);
  if (status.state === 'shared') return { accountId: account.id, state: 'shared', copied: 0, already: true };
  fs.mkdirSync(target, { recursive: true });
  let copied = 0;
  let backup = null;
  if (status.state === 'other-link') throw new Error(`${status.projects} already links somewhere else (${status.linkTo}). Remove that link first.`);
  if (status.state === 'unplugged') removeLink(status.projects);
  if (status.state === 'local') {
    copied = mergeTree(status.projects, target).copied;
    backup = `${status.projects}.before-engram-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    try {
      fs.renameSync(status.projects, backup);
    } catch (err) {
      if (/EBUSY|EPERM|EACCES/.test(err.code || '')) throw new Error('Claude Code seems to be running on this laptop. Close every Claude Code window, then click again.');
      throw err;
    }
  }
  fs.mkdirSync(path.dirname(status.projects), { recursive: true });
  try {
    makeLink(target, status.projects);
  } catch (err) {
    if (backup) fs.renameSync(backup, status.projects); // put everything back as it was
    throw new Error(`Could not create the link: ${err.message}`);
  }
  return { accountId: account.id, state: 'shared', copied, backup };
}

/** Undo: remove the link and give this laptop a normal folder with copies of the drive's sessions. */
function unshareAccount(account, target) {
  const status = accountStatus(account, target);
  if (status.state !== 'shared' && status.state !== 'unplugged') return { accountId: account.id, state: status.state, copied: 0 };
  removeLink(status.projects);
  fs.mkdirSync(status.projects, { recursive: true });
  const copied = fs.existsSync(target) ? mergeTree(target, status.projects).copied : 0;
  return { accountId: account.id, state: 'local', copied };
}

/** The drive remembers the letter it was set up with. */
function letterCheck(driveRoot, target, { remember = false, laptop = null } = {}) {
  const file = path.join(target, MARKER);
  const actual = letterOf(driveRoot);
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first time */ }
  if (!marker && remember) {
    marker = { letter: actual, setAt: new Date().toISOString(), by: laptop };
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker, null, 2));
  }
  const expected = marker ? marker.letter : null;
  return { expected, actual, ok: !expected || expected.toLowerCase() === actual.toLowerCase() };
}

/** Keep sessions for ~10 years instead of Claude Code's default 30-day cleanup. */
function keepSessionsLonger(configDir, days = 3650) {
  const file = path.join(configDir, 'settings.json');
  let json = {};
  if (fs.existsSync(file)) {
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { changed: false, reason: 'settings.json is not plain JSON; left untouched' }; }
  }
  if (typeof json.cleanupPeriodDays === 'number' && json.cleanupPeriodDays >= days) return { changed: false };
  json.cleanupPeriodDays = days;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return { changed: true };
}

module.exports = { FOLDER, sessionsTarget, letterOf, accountStatus, mergeTree, shareAccount, unshareAccount, letterCheck, keepSessionsLonger };
