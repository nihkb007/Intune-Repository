'use strict';
// FUSION: combine several sessions (from any account) into one compact "context capsule"
// that a fresh Claude session can load instead of re-reading history. It keeps what makes
// the next session cheaper and less error-prone: directives, goals, touched files, commands
// that worked, and errors that already happened.

const path = require('path');
const { clip } = require('./transcripts');

const estTokens = (s) => Math.ceil(String(s || '').length / 4);

const MARK_BEGIN = '<!-- ENGRAM:BEGIN — managed by ENGRAM, edits inside this block are replaced -->';
const MARK_END = '<!-- ENGRAM:END -->';

function rel(p, root) {
  if (!root || !p) return p;
  const r = path.relative(root, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
}

function normCmd(c) {
  return c.replace(/\s+/g, ' ').trim();
}

/**
 * @param details  session details (scanner.detail) in any order
 * @param opts     { notes, accounts, title, maxPrompts, maxFiles, maxCommands, maxErrors }
 */
function fuse(details, opts = {}) {
  const list = [...details].filter(Boolean).sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
  if (!list.length) throw new Error('Select at least one session to fuse.');
  const accounts = Object.fromEntries((opts.accounts || []).map((a) => [a.id, a]));
  const roots = [...new Set(list.map((s) => s.projectPath).filter(Boolean))];
  const root = roots.length === 1 ? roots[0] : null;
  const maxPrompts = opts.maxPrompts ?? 14;
  const maxFiles = opts.maxFiles ?? 25;
  const maxCommands = opts.maxCommands ?? 12;
  const maxErrors = opts.maxErrors ?? 10;

  // Goals: user prompts, deduped by their first line, keep the most recent phrasing.
  const seen = new Map();
  for (const s of list) {
    for (const p of s.prompts || []) {
      const k = p.text.split('\n')[0].toLowerCase().slice(0, 80);
      seen.set(k, { ...p, session: s.id });
    }
  }
  const prompts = [...seen.values()].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  const keptPrompts = prompts.length > maxPrompts
    ? [...prompts.slice(0, 3), ...prompts.slice(-(maxPrompts - 3))]
    : prompts;

  // Files: merged heat, ranked by writes+edits then reads.
  const files = {};
  for (const s of list) {
    for (const [fp, v] of Object.entries(s.files || {})) {
      const f = (files[fp] = files[fp] || { read: 0, edit: 0, write: 0 });
      f.read += v.read; f.edit += v.edit; f.write += v.write;
    }
  }
  const rankedFiles = Object.entries(files)
    .map(([fp, v]) => ({ path: rel(fp, root), ...v, score: (v.edit + v.write) * 3 + v.read }))
    .sort((a, b) => b.score - a.score);

  // Commands: frequency-ranked distinct commands.
  const cmdCount = new Map();
  for (const s of list) for (const c of s.commands || []) {
    const k = normCmd(c.cmd);
    const cur = cmdCount.get(k) || { cmd: k, n: 0, desc: c.desc };
    cur.n++;
    cmdCount.set(k, cur);
  }
  const commands = [...cmdCount.values()].sort((a, b) => b.n - a.n).slice(0, maxCommands);

  // Errors: distinct by first line → "known pitfalls".
  const errMap = new Map();
  for (const s of list) for (const e of s.errors || []) {
    const k = (e.text || '').split('\n')[0].slice(0, 120);
    if (!k) continue;
    const cur = errMap.get(k) || { ...e, n: 0 };
    cur.n++;
    errMap.set(k, cur);
  }
  const errors = [...errMap.values()].sort((a, b) => b.n - a.n).slice(0, maxErrors);

  const notes = (opts.notes || []).filter((n) => n.pinned || n.kind === 'directive' || n.kind === 'decision' || n.kind === 'lesson');
  const totalCost = list.reduce((a, s) => a + (s.cost || 0), 0);
  // Baseline: the context each session would reload on resume (its last main-chain window).
  const rawTokens = list.reduce((a, s) => a + (s.contextTokens || 0), 0);
  const acctNames = [...new Set(list.map((s) => accounts[s.accountId]?.name || s.accountId))];
  const from = list[0].startedAt?.slice(0, 10);
  const to = list[list.length - 1].endedAt?.slice(0, 10);
  const title = opts.title || `${roots.map((r) => path.basename(r)).join(' + ') || 'Sessions'} — fused context`;

  const L = [];
  L.push(`# ${title}`);
  L.push('');
  L.push(`> ENGRAM context capsule · ${list.length} session${list.length > 1 ? 's' : ''} · ${from}${to && to !== from ? ' → ' + to : ''} · accounts: ${acctNames.join(', ')}`);
  L.push('> Load this instead of replaying old sessions. It is the distilled memory of prior work.');
  L.push('');
  if (notes.length) {
    L.push('## Directives & decisions (always follow)');
    for (const n of notes) L.push(`- **${n.title}**${n.body ? ' — ' + clip(n.body.replace(/\n+/g, ' '), 300) : ''}`);
    L.push('');
  }
  if (keptPrompts.length) {
    L.push('## What was asked (chronological)');
    keptPrompts.forEach((p, i) => {
      if (prompts.length > maxPrompts && i === 3) L.push(`- … ${prompts.length - maxPrompts} more requests omitted …`);
      L.push(`- ${clip(p.text.replace(/\n+/g, ' '), 260)}`);
    });
    L.push('');
  }
  const outcomes = list.filter((s) => s.lastAssistantText);
  if (outcomes.length) {
    L.push('## Where each session ended');
    for (const s of outcomes.slice(-6)) {
      L.push(`- _${s.startedAt?.slice(0, 10) || ''} · ${s.title}_: ${clip(s.lastAssistantText.replace(/\n+/g, ' '), 360)}`);
    }
    L.push('');
  }
  if (rankedFiles.length) {
    L.push('## Key files');
    for (const f of rankedFiles.slice(0, maxFiles)) {
      const ops = [f.write && `${f.write}× write`, f.edit && `${f.edit}× edit`, f.read && `${f.read}× read`].filter(Boolean).join(', ');
      L.push(`- \`${f.path}\` (${ops})`);
    }
    if (rankedFiles.length > maxFiles) L.push(`- … and ${rankedFiles.length - maxFiles} more`);
    L.push('');
  }
  if (commands.length) {
    L.push('## Commands that were used');
    for (const c of commands) L.push(`- \`${clip(c.cmd, 160)}\`${c.n > 1 ? ` ×${c.n}` : ''}`);
    L.push('');
  }
  if (errors.length) {
    L.push('## Known pitfalls (errors already hit — do not repeat)');
    for (const e of errors) L.push(`- ${e.tool ? `[${e.tool}] ` : ''}${clip((e.text || '').replace(/\n+/g, ' '), 220)}${e.n > 1 ? ` (×${e.n})` : ''}`);
    L.push('');
  }
  const markdown = L.join('\n').trim() + '\n';
  const capsuleTokens = estTokens(markdown);

  return {
    title,
    markdown,
    sessionIds: list.map((s) => s.id),
    projects: roots,
    accounts: [...new Set(list.map((s) => s.accountId))],
    stats: {
      sessions: list.length,
      rawTokens,
      capsuleTokens,
      compression: rawTokens ? rawTokens / capsuleTokens : 0,
      sourceCost: totalCost,
      prompts: prompts.length,
      files: rankedFiles.length,
      commands: cmdCount.size,
      errors: errMap.size,
    },
  };
}

/** Insert or replace ENGRAM's managed block in an existing CLAUDE.md body. */
function injectManagedBlock(existing, content) {
  const block = `${MARK_BEGIN}\n${content.trim()}\n${MARK_END}`;
  const src = existing || '';
  const start = src.indexOf(MARK_BEGIN.slice(0, 20));
  const end = src.indexOf(MARK_END);
  if (start >= 0 && end > start) {
    return src.slice(0, start) + block + src.slice(end + MARK_END.length);
  }
  return (src.trim() ? src.replace(/\s*$/, '\n\n') : '') + block + '\n';
}

module.exports = { fuse, injectManagedBlock, estTokens, MARK_BEGIN, MARK_END };
