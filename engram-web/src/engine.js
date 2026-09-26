// Runs ENGRAM's engine (the same code as the desktop app) on a folder the user picks in
// the browser (File System Access API). Session files are read into the in-memory fs;
// ENGRAM's own data (notes, capsules, who-paid-what) is saved to <folder>/.engram/.
import fs from './shims/fs.js';
import { Store } from '../../engram/src/core/store.js';
import { Scanner } from '../../engram/src/core/scanner.js';
import * as sync from '../../engram/src/core/sync.js';

const ROOT = '/claude';
const PROJECTS = '/claude/projects';
const VAULT = '/vault';
const VAULT_FILE = '/vault/engram.json';

export class Engine {
  constructor() {
    this.handle = null; // FileSystemDirectoryHandle of the sessions folder
    this.dataDir = null; // .engram inside it
    this.index = new Map(); // rel path -> "lastModified:size"
    this.demo = false;
    this.listeners = new Set();
    this.saveTimer = null;
    this.saveError = null;
  }

  get folderName() { return this.demo ? 'demo data' : this.handle?.name || ''; }

  /** Walk the picked folder for Claude Code transcripts. */
  async walk(dir, rel = '', depth = 0, out = []) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.')) continue; // .engram and other hidden folders
      if (h.kind === 'directory' && depth < 4) await this.walk(h, `${rel}/${name}`, depth + 1, out);
      else if (h.kind === 'file' && name.endsWith('.jsonl')) out.push({ rel: `${rel}/${name}`, h });
    }
    return out;
  }

  /** Load new or changed files. Returns true when anything changed. */
  async load() {
    if (this.demo || !this.handle) return false;
    const found = await this.walk(this.handle);
    const seen = new Set();
    let changed = false;
    for (const { rel, h } of found) {
      seen.add(rel);
      const file = await h.getFile();
      const key = `${file.lastModified}:${file.size}`;
      if (this.index.get(rel) === key) continue;
      fs.__put(PROJECTS + rel, await file.text(), file.lastModified);
      this.index.set(rel, key);
      changed = true;
    }
    for (const rel of [...this.index.keys()]) {
      if (!seen.has(rel)) { fs.__remove(PROJECTS + rel); this.index.delete(rel); changed = true; }
    }
    return changed;
  }

  async connect(handle, { laptopName }) {
    fs.__reset();
    this.handle = handle;
    this.demo = false;
    this.index.clear();
    fs.__markLink(PROJECTS); // sessions folder shared on the drive: credit new messages to this laptop
    try {
      this.dataDir = await handle.getDirectoryHandle('.engram', { create: true });
      const f = await (await this.dataDir.getFileHandle('engram.json')).getFile();
      fs.__put(VAULT_FILE, await f.text(), f.lastModified);
    } catch { /* first visit: no vault yet */ }
    await this.load();
    fs.__onWrite((p, data) => { if (p === VAULT_FILE) this.scheduleSave(data); });
    this.boot(laptopName);
  }

  connectDemo(pack, { laptopName }) {
    fs.__reset();
    this.demo = true;
    this.handle = null;
    fs.__markLink(PROJECTS);
    for (const [rel, text] of Object.entries(pack.files)) fs.__put(PROJECTS + rel, text);
    if (pack.vault) fs.__put(VAULT_FILE, JSON.stringify(pack.vault));
    fs.__onWrite(() => {}); // demo changes stay in memory
    this.boot(laptopName);
  }

  boot(laptopName) {
    this.store = new Store(VAULT);
    const s = this.store.data.settings;
    s.autoArchive = false; // the drive already keeps every session
    s.sharedSessions = true;
    const { me, first } = sync.adoptThisMachine(this.store, [{ name: laptopName || 'THIS LAPTOP', configDir: ROOT }]);
    const machines = this.store.data.machines;
    if (laptopName && (!machines[me.id].renamed || machines[me.id].name !== laptopName)) {
      machines[me.id] = { ...machines[me.id], name: laptopName, renamed: true };
    }
    if (first) {
      // Give this laptop's account its own color if another laptop already took the default.
      const mine = sync.localAccounts(this.store)[0];
      const taken = new Set(this.store.data.accounts.filter((a) => a !== mine).map((a) => a.color));
      const color = ['#00f0ff', '#ff2bd6', '#fcee0a', '#3dff9a', '#8b7bff'].find((c) => !taken.has(c));
      if (mine && color) mine.color = color;
    }
    this.store.save(true);
    this.scanner = new Scanner({ store: this.store, dataDir: VAULT });
    this.scanner.checkouts = new Map(); // no local git checkouts to search in a browser
    this.model = this.scanner.scan();
    this.store.save(true);
  }

  scan() {
    this.model = this.scanner.scan();
    this.store.save(true);
    return this.model;
  }

  async refresh() {
    const changed = await this.load();
    if (changed) this.scan();
    return changed;
  }

  scheduleSave(data) {
    if (this.demo || !this.dataDir) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      try {
        const fh = await this.dataDir.getFileHandle('engram.json', { create: true });
        const w = await fh.createWritable();
        await w.write(data);
        await w.close();
        this.saveError = null;
      } catch (err) {
        this.saveError = err.message;
      }
    }, 300);
  }
}
