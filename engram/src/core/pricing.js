'use strict';
// Per-million-token list prices (USD) for Anthropic first-party API.
// cacheWrite5m = 1.25x input, cacheWrite1h = 2x input, cacheRead = 0.1x input
// unless a model publishes its own cache-read rate. Editable in Settings.

const M = (input, output, cacheRead) => ({
  input,
  output,
  cacheWrite5m: +(input * 1.25).toFixed(4),
  cacheWrite1h: +(input * 2).toFixed(4),
  cacheRead: cacheRead ?? +(input * 0.1).toFixed(4),
});

// Ordered most-specific first: the first key that is a prefix of the model id wins.
const DEFAULT_PRICING = {
  'claude-fable-5-1': M(10, 50, 0.25),
  'claude-mythos-5-1': M(10, 50, 0.25),
  'claude-fable-5': M(10, 50, 1),
  'claude-mythos-5': M(10, 50, 1),
  'claude-opus-5-5': M(4, 20, 0.2),
  'claude-opus-5': M(5, 25),
  'claude-opus-4-8': M(5, 25),
  'claude-opus-4-7': M(5, 25),
  'claude-opus-4-6': M(5, 25),
  'claude-opus-4-5': M(5, 25),
  'claude-opus-4-1': M(15, 75),
  'claude-opus-4': M(15, 75),
  'claude-sonnet-5': M(2, 10),
  'claude-sonnet-4-6': M(3, 15),
  'claude-sonnet-4-5': M(3, 15),
  'claude-sonnet-4': M(3, 15),
  'claude-3-7-sonnet': M(3, 15),
  'claude-haiku-4-5': M(1, 5),
  'claude-3-5-haiku': M(0.8, 4),
  'claude-3-5-sonnet': M(3, 15),
};

// Family fallbacks for ids we have never seen (e.g. future releases).
const FAMILY_FALLBACK = [
  [/fable|mythos/, 'claude-fable-5-1'],
  [/opus/, 'claude-opus-5'],
  [/sonnet/, 'claude-sonnet-5'],
  [/haiku/, 'claude-haiku-4-5'],
];

function normalizeModel(model) {
  if (!model) return 'unknown';
  // Strip provider prefixes (bedrock "anthropic.", vertex "@date") and context suffixes.
  return String(model)
    .replace(/^.*anthropic\./, '')
    .replace(/@.*$/, '')
    .replace(/\[.*\]$/, '')
    .toLowerCase();
}

function resolvePrice(model, table = DEFAULT_PRICING) {
  const id = normalizeModel(model);
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const k of keys) if (id.startsWith(k)) return { key: k, price: table[k] };
  for (const [re, k] of FAMILY_FALLBACK) if (re.test(id) && table[k]) return { key: k, price: table[k], estimated: true };
  return null;
}

/** Friendly display label: claude-opus-4-5-20251101 -> Opus 4.5 */
function modelLabel(model) {
  const id = normalizeModel(model);
  const m = id.match(/claude-(?:(\d+)-(\d+)-)?(opus|sonnet|haiku|fable|mythos)(?:-(\d+))?(?:-(\d+))?/);
  if (!m) return id;
  const fam = m[3][0].toUpperCase() + m[3].slice(1);
  if (m[1]) return `${fam} ${m[1]}.${m[2]}`; // claude-3-5-sonnet style
  const major = m[4];
  const minor = m[5] && m[5].length <= 2 ? m[5] : null;
  return minor ? `${fam} ${major}.${minor}` : major ? `${fam} ${major}` : fam;
}

/**
 * Cost of one usage block. Returns a breakdown in USD.
 * usage: Anthropic API usage object as written into Claude Code transcripts.
 */
function costOf(usage, model, table = DEFAULT_PRICING) {
  const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, saved: 0, priced: false };
  if (!usage) return zero;
  const r = resolvePrice(model, table);
  if (!r) return zero;
  const p = r.price;
  const perTok = (rate) => rate / 1e6;
  const input = (usage.input_tokens || 0) * perTok(p.input);
  const output = (usage.output_tokens || 0) * perTok(p.output);
  const cc = usage.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5mExplicit = cc.ephemeral_5m_input_tokens;
  const totalWrite = usage.cache_creation_input_tokens || 0;
  const w5m = w5mExplicit != null ? w5mExplicit : Math.max(0, totalWrite - w1h);
  const cacheWrite = w5m * perTok(p.cacheWrite5m) + w1h * perTok(p.cacheWrite1h);
  const reads = usage.cache_read_input_tokens || 0;
  const cacheRead = reads * perTok(p.cacheRead);
  const saved = reads * perTok(p.input - p.cacheRead);
  const total = input + output + cacheWrite + cacheRead;
  return { input, output, cacheWrite, cacheRead, total, saved, priced: true, estimated: !!r.estimated };
}

module.exports = { DEFAULT_PRICING, resolvePrice, costOf, normalizeModel, modelLabel };
