'use strict';
const { json, session, sameOriginWrite, readBody } = require('../lib/http');
const { createStore } = require('../lib/store');
const { sanitizePresets } = require('../lib/presets');

// Presets follow your login, so every laptop sees the same list.
module.exports = async (req, res) => {
  const { cfg, user } = await session(req);
  if (!cfg.enabled) return json(res, 403, { error: 'Login is not set up; presets are kept in this browser.' });
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  const store = createStore();
  if (store.kind === 'none') return json(res, 503, { error: 'No server storage connected; presets are kept in this browser.' });
  const key = `presets:${user}`;
  if (req.method === 'GET') return json(res, 200, { presets: (await store.get(key)) || [] });
  if (req.method === 'PUT') {
    if (!sameOriginWrite(req)) return json(res, 403, { error: 'Bad request origin' });
    let presets;
    try { presets = sanitizePresets((await readBody(req)).presets); } catch (err) { return json(res, 400, { error: err.message }); }
    await store.set(key, presets);
    return json(res, 200, { presets });
  }
  return json(res, 405, { error: 'GET or PUT' });
};
