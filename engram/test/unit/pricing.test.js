'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePrice, costOf, modelLabel, normalizeModel } = require('../../src/core/pricing');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('resolves the most specific model id, including dated snapshots', () => {
  assert.equal(resolvePrice('claude-opus-5-5').key, 'claude-opus-5-5');
  assert.equal(resolvePrice('claude-opus-5').key, 'claude-opus-5');
  assert.equal(resolvePrice('claude-opus-4-5-20251101').key, 'claude-opus-4-5');
  assert.equal(resolvePrice('claude-opus-4-20250514').key, 'claude-opus-4');
  assert.equal(resolvePrice('claude-sonnet-4-5-20250929').key, 'claude-sonnet-4-5');
});

test('normalizes provider prefixes and suffixes', () => {
  assert.equal(normalizeModel('us.anthropic.claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(normalizeModel('claude-opus-4-5@20251101'), 'claude-opus-4-5');
  assert.equal(normalizeModel('claude-opus-5[1m]'), 'claude-opus-5');
});

test('unknown future models fall back by family and are flagged estimated', () => {
  const r = resolvePrice('claude-sonnet-9');
  assert.equal(r.key, 'claude-sonnet-5');
  assert.equal(r.estimated, true);
  assert.equal(resolvePrice('gpt-4o'), null);
});

test('costs input, output, 5m/1h cache writes and cache reads separately', () => {
  // Opus 5.5: $4 in, $20 out, 5m write 5, 1h write 8, read 0.20 per MTok
  const c = costOf({
    input_tokens: 1_000_000, output_tokens: 1_000_000,
    cache_creation_input_tokens: 3_000_000, cache_read_input_tokens: 10_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 2_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  }, 'claude-opus-5-5');
  close(c.input, 4);
  close(c.output, 20);
  close(c.cacheWrite, 2 * 5 + 1 * 8);
  close(c.cacheRead, 10 * 0.2);
  close(c.total, 4 + 20 + 18 + 2);
  close(c.saved, 10 * (4 - 0.2));
});

test('cache writes without a TTL breakdown are priced as 5-minute writes', () => {
  const c = costOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }, 'claude-sonnet-5');
  close(c.cacheWrite, 2.5);
});

test('synthetic / unknown models cost nothing', () => {
  assert.equal(costOf({ input_tokens: 100 }, '<synthetic>').total, 0);
  assert.equal(costOf(null, 'claude-opus-5').total, 0);
});

test('model labels are human readable', () => {
  assert.equal(modelLabel('claude-opus-4-5-20251101'), 'Opus 4.5');
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelLabel('claude-3-5-haiku-20241022'), 'Haiku 3.5');
  assert.equal(modelLabel('claude-opus-4-20250514'), 'Opus 4');
});
