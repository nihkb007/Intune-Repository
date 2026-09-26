'use strict';
// In-memory stand-in for Node's `fs`, so ENGRAM's engine (written for Node) runs unchanged
// in the browser. The web layer loads the chosen folder's files into it, and gets told
// whenever the engine writes a file so it can save it back to the drive.

const posix = require('path-browserify');

const files = new Map(); // abs path -> { data: string, mtimeMs: number }
const dirs = new Set(['/']);
const links = new Set(); // paths reported as symbolic links (e.g. /claude/projects)
let onWrite = null;

const norm = (p) => posix.resolve('/', String(p));

function addDirChain(p) {
  let cur = norm(p);
  while (cur && !dirs.has(cur)) {
    dirs.add(cur);
    const up = posix.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
}

function enoent(p, op) {
  const e = new Error(`ENOENT: no such file or directory, ${op} '${p}'`);
  e.code = 'ENOENT';
  return e;
}

function stat(p) {
  const n = norm(p);
  const f = files.get(n);
  if (f) {
    const size = new TextEncoder().encode(f.data).length;
    return { size, mtimeMs: f.mtimeMs, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  }
  if (dirs.has(n)) return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => links.has(n) };
  throw enoent(p, 'stat');
}

const fs = {
  // ---- web layer API ----
  __put(p, data, mtimeMs = Date.now()) {
    const n = norm(p);
    addDirChain(posix.dirname(n));
    files.set(n, { data: String(data), mtimeMs });
  },
  __remove(p) { files.delete(norm(p)); },
  __markLink(p) { addDirChain(p); links.add(norm(p)); },
  __onWrite(fn) { onWrite = fn; },
  __files() { return files; },
  __reset() { files.clear(); dirs.clear(); dirs.add('/'); links.clear(); },

  // ---- Node-compatible subset ----
  existsSync(p) { const n = norm(p); return files.has(n) || dirs.has(n); },
  statSync: stat,
  lstatSync: stat,
  realpathSync(p) { return norm(p); },
  readFileSync(p) {
    const f = files.get(norm(p));
    if (!f) throw enoent(p, 'open');
    return f.data;
  },
  writeFileSync(p, data) {
    const n = norm(p);
    addDirChain(posix.dirname(n));
    files.set(n, { data: String(data), mtimeMs: Date.now() });
    if (onWrite && !n.endsWith('.tmp') && !n.endsWith('.partial')) onWrite(n, String(data));
  },
  appendFileSync(p, data) {
    const n = norm(p);
    fs.writeFileSync(n, (files.get(n)?.data || '') + String(data));
  },
  renameSync(a, b) {
    const f = files.get(norm(a));
    if (!f) throw enoent(a, 'rename');
    files.delete(norm(a));
    fs.writeFileSync(b, f.data);
  },
  copyFileSync(a, b) { fs.writeFileSync(b, fs.readFileSync(a)); },
  unlinkSync(p) { files.delete(norm(p)); },
  rmSync(p) {
    const n = norm(p);
    files.delete(n);
    for (const k of [...files.keys()]) if (k.startsWith(n + '/')) files.delete(k);
  },
  mkdirSync(p) { addDirChain(p); },
  readdirSync(p, opts = {}) {
    const n = norm(p);
    if (!dirs.has(n)) throw enoent(p, 'scandir');
    const names = new Map();
    const prefix = n === '/' ? '/' : n + '/';
    for (const f of files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const [head, ...more] = rest.split('/');
      names.set(head, more.length ? 'dir' : 'file');
    }
    for (const d of dirs) {
      if (d === n || !d.startsWith(prefix)) continue;
      const head = d.slice(prefix.length).split('/')[0];
      if (!names.has(head)) names.set(head, 'dir');
    }
    const list = [...names.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (!opts.withFileTypes) return list.map(([name]) => name);
    return list.map(([name, kind]) => ({ name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir' }));
  },
  watch() { return { close() {} }; },
};

module.exports = fs;
