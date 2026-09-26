'use strict';
// Where portal data (presets, login attempt counters) lives on the server.
// - Upstash Redis REST (what Vercel's Redis/KV marketplace integration provides):
//   KV_REST_API_URL + KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// - ENGRAM_STORE=memory: in-process only, for local development and tests
// - none: presets stay in each browser

const memory = new Map();

function config(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { kind: 'redis', url: url.replace(/\/+$/, ''), token };
  if (env.ENGRAM_STORE === 'memory') return { kind: 'memory' };
  return { kind: 'none' };
}

async function redis(cfg, command) {
  const res = await fetch(cfg.url, { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  if (!res.ok) throw new Error(`storage error ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`storage error: ${body.error}`);
  return body.result;
}

function createStore(env = process.env) {
  const cfg = config(env);
  const expiry = new Map();
  const alive = (k) => { const t = expiry.get(k); if (t && t < Date.now()) { memory.delete(k); expiry.delete(k); } return memory.has(k); };
  return {
    kind: cfg.kind,
    async get(key) {
      if (cfg.kind === 'redis') { const v = await redis(cfg, ['GET', key]); return v == null ? null : JSON.parse(v); }
      if (cfg.kind === 'memory') return alive(key) ? JSON.parse(memory.get(key)) : null;
      return null;
    },
    async set(key, value) {
      if (cfg.kind === 'redis') return redis(cfg, ['SET', key, JSON.stringify(value)]);
      if (cfg.kind === 'memory') { memory.set(key, JSON.stringify(value)); return 'OK'; }
      throw new Error('No server storage configured');
    },
    /** Set only if the key is new; true when this call set it. */
    async setnx(key, value) {
      if (cfg.kind === 'redis') return (await redis(cfg, ['SET', key, JSON.stringify(value), 'NX'])) === 'OK';
      if (cfg.kind === 'memory') { if (alive(key)) return false; memory.set(key, JSON.stringify(value)); return true; }
      throw new Error('No server storage configured');
    },
    /** Counter with a time window (login attempts). */
    async hit(key, windowSec) {
      if (cfg.kind === 'redis') {
        const n = await redis(cfg, ['INCR', key]);
        if (n === 1) await redis(cfg, ['EXPIRE', key, windowSec]);
        return n;
      }
      const n = (alive(key) ? JSON.parse(memory.get(key)) : 0) + 1;
      memory.set(key, JSON.stringify(n));
      if (n === 1) expiry.set(key, Date.now() + windowSec * 1000);
      return n;
    },
    async clear(key) {
      if (cfg.kind === 'redis') return redis(cfg, ['DEL', key]);
      memory.delete(key);
      expiry.delete(key);
      return 1;
    },
  };
}

module.exports = { createStore, storeConfig: config, _memory: memory };
