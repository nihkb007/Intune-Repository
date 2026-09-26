'use strict';
// Parser for Claude Code session transcripts (<configDir>/projects/<slug>/<sessionId>.jsonl).
// Each line is a JSON event. Assistant events carry message.usage; one API message may be
// split across several lines (one per content block) that repeat the same usage, so usage
// is keyed by message id + request id and counted once.

const fs = require('fs');
const path = require('path');

const FILE_TOOLS = {
  Read: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'write', NotebookEdit: 'edit',
  Glob: null, Grep: null,
};

function safeJSON(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (!b) return '';
      if (typeof b === 'string') return b;
      if (b.type === 'text') return b.text || '';
      if (b.type === 'tool_result') return textOf(b.content);
      return '';
    }).join('\n');
  }
  return '';
}

function clip(s, n) {
  s = String(s || '').replace(/\s+\n/g, '\n').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function isNoisePrompt(t) {
  return !t
    || t.startsWith('<command-')
    || t.startsWith('<local-command')
    || t.startsWith('Caveat:')
    || t.startsWith('<system-reminder>')
    || t.startsWith('[Request interrupted');
}

/** Decode a projects/<slug> directory name back to something path-like. */
function slugToPath(slug) {
  return slug.replace(/^-/, '/').replace(/-/g, '/');
}

function projectNameFrom(p) {
  if (!p) return 'unknown';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function dayKey(ts) {
  return ts ? ts.slice(0, 10) : null;
}

/**
 * Parse transcript text. Returns { session, usageEntries, events }.
 * usageEntries: [{ key, ts, model, usage }] — caller prices + dedupes globally.
 * events (only when opts.events): replay timeline.
 */
function parseTranscript(text, opts = {}) {
  const lines = text.split('\n');
  const s = {
    id: null,
    projectPath: null,
    gitBranch: null,
    version: null,
    title: null,
    summary: null,
    startedAt: null,
    endedAt: null,
    prompts: [],
    lastAssistantText: '',
    tools: {},
    files: {},
    commands: [],
    errors: [],
    turns: { user: 0, assistant: 0 },
    sidechain: 0,
  };
  const usageEntries = [];
  const seenUsage = new Set();
  const events = [];
  const pendingTools = new Map();

  for (const line of lines) {
    if (!line.trim()) continue;
    const e = safeJSON(line);
    if (!e) continue;

    if (e.type === 'summary' && e.summary) { s.summary = e.summary; continue; }
    if (e.type === 'custom-title' && e.customTitle) { s.title = e.customTitle; continue; }
    if (e.type !== 'user' && e.type !== 'assistant') continue;

    if (!s.id && e.sessionId) s.id = e.sessionId;
    if (e.cwd && !s.projectPath) s.projectPath = e.cwd;
    if (e.gitBranch && !s.gitBranch) s.gitBranch = e.gitBranch;
    if (e.version) s.version = e.version;
    if (e.timestamp) {
      if (!s.startedAt || e.timestamp < s.startedAt) s.startedAt = e.timestamp;
      if (!s.endedAt || e.timestamp > s.endedAt) s.endedAt = e.timestamp;
    }
    if (e.isSidechain) s.sidechain++;
    const msg = e.message || {};

    if (e.type === 'user') {
      const content = msg.content;
      const blocks = Array.isArray(content) ? content : null;
      const toolResults = blocks ? blocks.filter((b) => b && b.type === 'tool_result') : [];
      for (const tr of toolResults) {
        const t = textOf(tr.content);
        const tool = pendingTools.get(tr.tool_use_id);
        if (tr.is_error) {
          s.errors.push({ ts: e.timestamp, tool: tool ? tool.name : null, text: clip(t, 400) });
        }
        if (opts.events) {
          events.push({ ts: e.timestamp, role: 'tool', kind: 'tool_result', tool: tool ? tool.name : null, isError: !!tr.is_error, text: clip(t, 1500) });
        }
      }
      if (!toolResults.length && !e.isMeta) {
        const t = textOf(content).trim();
        if (!isNoisePrompt(t)) {
          s.turns.user++;
          if (!e.isSidechain) s.prompts.push({ ts: e.timestamp, text: clip(t, 2000) });
          if (opts.events) events.push({ ts: e.timestamp, role: 'user', kind: 'text', text: clip(t, 4000), sidechain: !!e.isSidechain });
        }
      }
      continue;
    }

    // assistant
    const key = `${msg.id || e.uuid}:${e.requestId || ''}`;
    if (msg.usage && msg.model !== '<synthetic>' && !seenUsage.has(key)) {
      seenUsage.add(key);
      s.turns.assistant++;
      usageEntries.push({ key, ts: e.timestamp, model: msg.model, usage: msg.usage, side: !!e.isSidechain });
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text' && b.text && b.text.trim()) {
        if (!e.isSidechain) s.lastAssistantText = b.text;
        if (opts.events) events.push({ ts: e.timestamp, role: 'assistant', kind: 'text', text: clip(b.text, 4000), model: msg.model, sidechain: !!e.isSidechain });
      } else if (b.type === 'tool_use') {
        pendingTools.set(b.id, b);
        s.tools[b.name] = (s.tools[b.name] || 0) + 1;
        const input = b.input || {};
        const fp = input.file_path || input.notebook_path || null;
        if (fp && FILE_TOOLS[b.name]) {
          const f = (s.files[fp] = s.files[fp] || { read: 0, edit: 0, write: 0 });
          f[FILE_TOOLS[b.name]]++;
        }
        if (b.name === 'Bash' && input.command) {
          s.commands.push({ ts: e.timestamp, cmd: clip(input.command, 300), desc: input.description || '' });
        }
        if (opts.events) {
          events.push({ ts: e.timestamp, role: 'assistant', kind: 'tool_use', tool: b.name, text: clip(describeToolInput(b.name, input), 1200), sidechain: !!e.isSidechain });
        }
      }
    }
  }

  if (!s.title) {
    s.title = s.summary || (s.prompts[0] ? clip(s.prompts[0].text.split('\n')[0], 90) : 'Untitled session');
  }
  s.lastAssistantText = clip(s.lastAssistantText, 1500);
  return { session: s, usageEntries, events };
}

function describeToolInput(name, input) {
  if (!input || typeof input !== 'object') return String(input || '');
  if (name === 'Bash') return `$ ${input.command || ''}`;
  if (input.file_path) return `${input.file_path}${input.old_string ? '  (edit)' : ''}`;
  if (input.pattern) return `${input.pattern}${input.path ? '  in ' + input.path : ''}`;
  if (input.url) return input.url;
  if (input.prompt) return input.prompt;
  if (input.description) return input.description;
  try { return JSON.stringify(input); } catch { return ''; }
}

/** Recursively list *.jsonl transcripts under <configDir>/projects. */
function listTranscriptFiles(configDir) {
  const root = path.join(configDir, 'projects');
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir, slug, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory() && depth < 4) walk(full, slug || ent.name, depth + 1);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        out.push({ file: full, slug, size: st.size, mtimeMs: st.mtimeMs, nested: depth > 1 });
      }
    }
  };
  walk(root, null, 0);
  return out;
}

module.exports = { parseTranscript, listTranscriptFiles, slugToPath, projectNameFrom, dayKey, textOf, clip };
