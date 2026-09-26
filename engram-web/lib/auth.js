'use strict';
// Portal login: users from ENGRAM_USERS ("name:pbkdf2$iterations$salt$hash", comma separated),
// sessions as an HMAC-signed cookie using ENGRAM_SESSION_SECRET. Web Crypto only, so the same
// code runs in Vercel functions, Node tests and the local dev server.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const COOKIE = 'engram_session';
const SESSION_DAYS = 30;
const ITERATIONS = 310000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

async function pbkdf2(password, salt, iterations = ITERATIONS) {
  const key = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** "pbkdf2$310000$<salt>$<hash>" for ENGRAM_USERS. */
async function hashPassword(password) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64u(salt)}$${b64u(await pbkdf2(password, salt))}`;
}

async function verifyPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored || '').split('$');
  if (kind !== 'pbkdf2' || !iter || !salt || !hash) return false;
  return equal(await pbkdf2(String(password), fromB64u(salt), Number(iter)), fromB64u(hash));
}

function parseUsers(env = process.env) {
  const users = new Map();
  for (const entry of String(env.ENGRAM_USERS || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(':');
    if (i > 0) users.set(entry.slice(0, i).trim().toLowerCase(), entry.slice(i + 1).trim());
  }
  return users;
}

/** Login is on when both variables are set; otherwise the portal runs without it. */
function authConfig(env = process.env) {
  const users = parseUsers(env);
  const secret = env.ENGRAM_SESSION_SECRET || '';
  return { enabled: users.size > 0 && secret.length >= 32, users, secret, misconfigured: users.size > 0 && secret.length < 32 };
}

async function hmac(secret, data) {
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, enc.encode(data)));
}

async function signSession(user, secret, now = Date.now()) {
  const payload = b64u(enc.encode(JSON.stringify({ u: user, exp: now + SESSION_DAYS * 86400000 })));
  return `${payload}.${b64u(await hmac(secret, payload))}`;
}

async function readSession(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  if (!equal(await hmac(secret, payload), fromB64u(sig))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return s.exp > now ? { user: s.u, exp: s.exp } : null;
  } catch { return null; }
}

function getCookie(req, name = COOKIE) {
  const header = req.headers?.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function sessionCookie(token, { secure = true, clear = false } = {}) {
  return [
    `${COOKIE}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    secure ? 'Secure' : null,
    `Max-Age=${clear ? 0 : SESSION_DAYS * 86400}`,
  ].filter(Boolean).join('; ');
}

module.exports = { COOKIE, hashPassword, verifyPassword, parseUsers, authConfig, signSession, readSession, getCookie, sessionCookie };
