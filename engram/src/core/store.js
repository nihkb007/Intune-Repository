'use strict';
// Tiny durable JSON store. Writes are atomic (write temp + rename) and debounced so a
// burst of edits results in one disk write. Everything ENGRAM remembers lives here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = () => ({
  version: 1,
  createdAt: new Date().toISOString(),
  accounts: [],
  activeAccountId: null,
  notes: [],
  capsules: [],
  bridgeLedger: {},
  recordings: {},
  tombstones: {},
  syncState: { exported: {}, imported: {} },
  settings: {
    monthlyBudget: 200,
    currency: 'USD',
    pricingOverrides: {},
    autoArchive: true,
    effects: 'full',
    injectOnFuse: false,
    sync: {},
  },
});

class Store {
  constructor(dir, file = 'engram.json') {
    this.dir = dir;
    this.file = path.join(dir, file);
    fs.mkdirSync(dir, { recursive: true });
    this.data = this._load();
    this._timer = null;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const d = DEFAULTS();
      return { ...d, ...raw, settings: { ...d.settings, ...(raw.settings || {}), sync: { ...(raw.settings?.sync || {}) } } };
    } catch (err) {
      if (fs.existsSync(this.file)) {
        // Corrupt file: keep a copy rather than silently discarding memory.
        try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); } catch {}
      }
      return DEFAULTS();
    }
  }

  save(immediate = false) {
    if (immediate) return this._flush();
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), 150);
  }

  _flush() {
    clearTimeout(this._timer);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  static id(prefix = '') {
    return prefix + crypto.randomBytes(6).toString('hex');
  }

  // ---- notes ---------------------------------------------------------------
  listNotes(filter = {}) {
    let n = this.data.notes;
    if (filter.project) n = n.filter((x) => x.project === filter.project || x.scope === 'global');
    if (filter.q) {
      const q = filter.q.toLowerCase();
      n = n.filter((x) => (x.title + ' ' + x.body + ' ' + (x.tags || []).join(' ')).toLowerCase().includes(q));
    }
    return [...n].sort((a, b) => (b.pinned - a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }

  upsertNote(patch) {
    const now = new Date().toISOString();
    const existing = patch.id ? this.data.notes.find((x) => x.id === patch.id) : null;
    const note = existing ? { ...existing, ...patch } : patch;
    const clean = {
      title: String(note.title || 'Untitled').slice(0, 200),
      body: String(note.body || ''),
      tags: Array.isArray(note.tags) ? note.tags.map(String).slice(0, 20) : [],
      project: note.project || null,
      scope: note.scope === 'global' ? 'global' : 'project',
      kind: ['note', 'directive', 'decision', 'lesson'].includes(note.kind) ? note.kind : 'note',
      pinned: !!note.pinned,
    };
    if (existing) {
      const i = this.data.notes.indexOf(existing);
      this.data.notes[i] = { ...existing, ...clean, updatedAt: now };
      this.save();
      return this.data.notes[i];
    }
    const created = { id: Store.id('n_'), ...clean, createdAt: now, updatedAt: now };
    this.data.notes.push(created);
    this.save();
    return created;
  }

  deleteNote(id) {
    const before = this.data.notes.length;
    this.data.notes = this.data.notes.filter((x) => x.id !== id);
    // Remember the deletion so other laptops drop their copy instead of restoring it.
    if (before !== this.data.notes.length) this.data.tombstones[id] = new Date().toISOString();
    this.save();
    return before !== this.data.notes.length;
  }

  // ---- capsules (fused contexts) ---------------------------------------------
  addCapsule(c) {
    const created = { id: Store.id('c_'), createdAt: new Date().toISOString(), ...c };
    this.data.capsules.unshift(created);
    this.data.capsules = this.data.capsules.slice(0, 200);
    this.save();
    return created;
  }

  deleteCapsule(id) {
    this.data.capsules = this.data.capsules.filter((x) => x.id !== id);
    this.data.tombstones[id] = new Date().toISOString();
    this.save();
  }

  // ---- accounts --------------------------------------------------------------
  upsertAccount(patch) {
    const existing = patch.id ? this.data.accounts.find((x) => x.id === patch.id) : null;
    const a = existing ? { ...existing, ...patch } : patch;
    const clean = {
      name: String(a.name || 'Account').slice(0, 60),
      configDir: String(a.configDir || ''),
      color: /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : '#00f0ff',
      email: a.email || null,
      plan: a.plan || null,
    };
    if (existing) {
      const i = this.data.accounts.indexOf(existing);
      this.data.accounts[i] = { ...existing, ...clean };
      this.save();
      return this.data.accounts[i];
    }
    const created = { id: patch.id || Store.id('a_'), ...clean };
    this.data.accounts.push(created);
    if (!this.data.activeAccountId) this.data.activeAccountId = created.id;
    this.save();
    return created;
  }

  removeAccount(id) {
    this.data.accounts = this.data.accounts.filter((x) => x.id !== id);
    if (this.data.activeAccountId === id) this.data.activeAccountId = this.data.accounts[0]?.id || null;
    this.save();
  }

  setActiveAccount(id) {
    if (this.data.accounts.some((a) => a.id === id)) {
      this.data.activeAccountId = id;
      this.save();
    }
    return this.data.activeAccountId;
  }

  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }
}

module.exports = { Store };
