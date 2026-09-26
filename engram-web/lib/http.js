'use strict';
const { readSession, getCookie } = require('./auth');
const { loadAuth } = require('./accounts');

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

/** HTTPS everywhere except the local dev server. */
function isSecure(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (proto) return proto.split(',')[0].trim() === 'https';
  return !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
}

/** Reject cross-site writes: browsers can't send custom headers cross-origin without CORS. */
function sameOriginWrite(req) {
  return req.headers['x-engram'] === '1';
}

async function session(req, env = process.env) {
  const cfg = await loadAuth(env);
  if (!cfg.enabled) return { cfg, user: null };
  const s = await readSession(getCookie(req), cfg.secret);
  return { cfg, user: s && cfg.users.has(s.user) ? s.user : null };
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw new Error('body too large'); }
  return raw ? JSON.parse(raw) : {};
}

module.exports = { json, isSecure, sameOriginWrite, session, readBody };
