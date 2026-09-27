// Presets: on your drive (<sessions folder>/.engram/presets.json, so both laptops see them),
// on the portal server when you're signed in and it has storage, or else in this browser.
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
  constructor(mode, dir = null) {
    this.mode = mode; // 'drive' | 'server' | 'local'
    this.dir = dir; // sessions folder handle, for 'drive'
    this.cache = [];
  }

  async readDrive() {
    try {
      const data = await this.dir.getDirectoryHandle('.engram');
      const text = await (await (await data.getFileHandle('presets.json')).getFile()).text();
      const list = JSON.parse(text).presets;
      return Array.isArray(list) ? list : [];
    } catch { return null; } // none yet
  }

  async writeDrive(list) {
    const data = await this.dir.getDirectoryHandle('.engram', { create: true });
    const w = await (await data.getFileHandle('presets.json', { create: true })).createWritable();
    await w.write(JSON.stringify({ presets: list }, null, 2));
    await w.close();
  }

  readLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL) || '[]'); } catch { return []; }
  }

  writeLocal(list) {
    try { localStorage.setItem(LOCAL, JSON.stringify(list)); } catch { /* private mode */ }
  }

  async load() {
    if (this.mode === 'drive') {
      const saved = await this.readDrive();
      this.cache = saved || [];
      // First time on the drive: move presets made in this browser before onto it.
      const local = this.readLocal();
      if (!saved && local.length) await this.save(local);
      return this.cache;
    }
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
    if (this.mode === 'drive') {
      await this.writeDrive(list);
      this.cache = list;
    } else if (this.mode === 'server') {
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
