// Presets in the browser: kept on the portal server when you're signed in and it has
// storage, otherwise in this browser's localStorage.
export const VIEWS = { nexus: 'Dashboard', projects: 'Projects', recordings: 'Recordings', vault: 'Vault', fusion: 'Fusion', resume: 'Latest session (resume)' };
const COLORS = ['#00f0ff', '#ff2bd6', '#fcee0a', '#3dff9a', '#8b7bff', '#ff8a3d'];
const LOCAL = 'engram.presets';

export function blankPreset(i = 0) {
  const drive = 'E';
  return {
    id: `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: i === 0 ? 'WORK LAPTOP' : i === 1 ? 'PERSONAL LAPTOP' : `PRESET ${i + 1}`,
    laptop: i === 0 ? 'WORK' : i === 1 ? 'PERSONAL' : '',
    drive,
    folder: `${drive}:\\claude-sessions`,
    view: 'resume',
    color: COLORS[i % COLORS.length],
    updatedAt: new Date().toISOString(),
  };
}

export class Presets {
  constructor(mode) {
    this.mode = mode; // 'server' | 'local'
    this.cache = [];
  }

  readLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL) || '[]'); } catch { return []; }
  }

  writeLocal(list) {
    try { localStorage.setItem(LOCAL, JSON.stringify(list)); } catch { /* private mode */ }
  }

  async load() {
    if (this.mode === 'server') {
      const r = await fetch('api/presets', { credentials: 'same-origin' });
      if (r.ok) {
        this.cache = (await r.json()).presets;
        // First sign-in: move presets made in this browser before to the account.
        const local = this.readLocal();
        if (!this.cache.length && local.length) await this.save(local);
        return this.cache;
      }
      this.mode = 'local'; // server storage unavailable: keep working locally
    }
    this.cache = this.readLocal();
    return this.cache;
  }

  async save(list) {
    if (this.mode === 'server') {
      const r = await fetch('api/presets', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Engram': '1' }, body: JSON.stringify({ presets: list }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not save presets');
      this.cache = (await r.json()).presets;
    } else {
      this.cache = list;
    }
    this.writeLocal(this.cache);
    return this.cache;
  }
}
