'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = (prefix = 'engram-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

let n = 0;
/** Build a transcript: turns = [{prompt, model, usage, tools:[{name,input,error}] , reply}] */
function transcript({ sessionId = 's-' + (++n), cwd = '/work/proj', turns, summary }) {
  const L = [];
  if (summary) L.push({ type: 'summary', summary });
  let t = Date.parse('2026-09-01T10:00:00Z');
  const ts = () => new Date((t += 60000)).toISOString();
  turns.forEach((turn, ti) => {
    L.push({ type: 'user', sessionId, cwd, timestamp: ts(), message: { role: 'user', content: turn.prompt } });
    const id = `msg_${sessionId}_${ti}`;
    const content = [{ type: 'text', text: turn.reply || 'ok' }];
    (turn.tools || []).forEach((tl, k) => content.push({ type: 'tool_use', id: `tu_${ti}_${k}`, name: tl.name, input: tl.input }));
    // streamed: one line per block, same usage repeated
    for (const block of content) {
      L.push({ type: 'assistant', sessionId, cwd, timestamp: ts(), requestId: `req_${ti}`, message: { id, role: 'assistant', model: turn.model || 'claude-sonnet-5', content: [block], usage: turn.usage } });
    }
    (turn.tools || []).forEach((tl, k) => L.push({ type: 'user', sessionId, cwd, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${ti}_${k}`, is_error: !!tl.error, content: tl.error || 'fine' }] } }));
  });
  return L.map((x) => JSON.stringify(x)).join('\n') + '\n';
}

function writeSession(configDir, slug, sessionId, text) {
  const dir = path.join(configDir, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(f, text);
  return f;
}

const U = (i, o, cw = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });

module.exports = { tmp, transcript, writeSession, U };
