'use strict';
// A preset = how to open ENGRAM on one laptop: its account label, drive, folder, first screen.
const VIEWS = ['nexus', 'projects', 'recordings', 'vault', 'fusion', 'resume'];
const COLORS = ['#00f0ff', '#ff2bd6', '#fcee0a', '#3dff9a', '#8b7bff', '#ff8a3d'];
const MAX = 30;

const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

function sanitizePreset(p, i = 0) {
  const drive = str(p.drive, 1).toUpperCase();
  const letter = /^[A-Z]$/.test(drive) ? drive : 'E';
  return {
    id: /^[a-z0-9_-]{4,40}$/i.test(p.id || '') ? p.id : `p_${Date.now().toString(36)}${i}`,
    name: str(p.name, 60) || `${letter}: sessions`,
    laptop: str(p.laptop, 40) || 'THIS LAPTOP',
    drive: letter,
    folder: str(p.folder, 200) || `${letter}:\\claude-sessions`,
    view: VIEWS.includes(p.view) ? p.view : 'nexus',
    color: COLORS.includes(p.color) ? p.color : COLORS[i % COLORS.length],
    updatedAt: str(p.updatedAt, 40) || new Date().toISOString(),
  };
}

function sanitizePresets(list) {
  if (!Array.isArray(list)) throw new Error('presets must be a list');
  if (list.length > MAX) throw new Error(`at most ${MAX} presets`);
  return list.map(sanitizePreset);
}

module.exports = { sanitizePreset, sanitizePresets, VIEWS, COLORS };
