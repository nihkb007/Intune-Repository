'use strict';
// Who can sign in, and the secret that signs their sessions.
// - The account made on the site's first-run page is kept in server storage (Redis), together
//   with a session secret generated at that moment. Making it needs the deployment's setup code
//   (ENGRAM_SETUP_CODE, which only the Vercel project owner can see), so a stranger who finds
//   the address first can't claim the site.
// - ENGRAM_USERS / ENGRAM_SESSION_SECRET still work and take precedence.
const { parseUsers, hashPassword, sameText } = require('./auth');
const { createStore } = require('./store');

const ACCOUNTS = 'accounts';
const SECRET = 'config:session-secret';
const WINDOW = 15 * 60;
const MAX_TRIES = 8;

const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

async function loadAuth(env = process.env, store = createStore(env)) {
  const users = parseUsers(env);
  let secret = env.ENGRAM_SESSION_SECRET || '';
  let storeError = null;
  if (store.kind !== 'none') {
    try {
      for (const [name, hash] of Object.entries((await store.get(ACCOUNTS)) || {})) if (!users.has(name)) users.set(name, hash);
      if (secret.length < 32) secret = (await store.get(SECRET)) || secret;
    } catch (err) { storeError = err.message; }
  }
  const ok = secret.length >= 32;
  return {
    users, secret, store, storeError,
    enabled: users.size > 0 && ok,
    misconfigured: users.size > 0 && !ok,
    // First run: nobody can sign in yet, so the site offers to make the account.
    setupOpen: users.size === 0 && !storeError,
    hasSetupCode: normCode(env.ENGRAM_SETUP_CODE).length >= 8,
  };
}

class SetupError extends Error { constructor(status, message) { super(message); this.status = status; } }

/** First-run account creation. Returns { user, secret } or throws SetupError. */
async function createFirstAccount({ username, password, code, ip }, env = process.env) {
  const store = createStore(env);
  if (store.kind === 'none') throw new SetupError(503, 'Connect storage first (step 1).');
  const auth = await loadAuth(env, store);
  if (auth.storeError) throw new SetupError(503, `Storage isn't answering: ${auth.storeError}`);
  if (!auth.setupOpen) throw new SetupError(409, 'This site already has an account. Sign in instead.');
  if (!auth.hasSetupCode) throw new SetupError(503, 'This deployment has no setup code yet (step 2).');
  const failKey = `setup-fail:${ip}`;
  if ((await store.hit(failKey, WINDOW)) > MAX_TRIES) throw new SetupError(429, 'Too many attempts. Try again in 15 minutes.');
  if (!sameText(normCode(code), normCode(env.ENGRAM_SETUP_CODE))) {
    await new Promise((r) => setTimeout(r, 400));
    throw new SetupError(403, 'That setup code doesn’t match. Copy ENGRAM_SETUP_CODE from Vercel again.');
  }
  const user = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(user)) throw new SetupError(400, 'User name: 2–32 letters, numbers, dots, dashes or underscores.');
  const pass = String(password || '');
  if (pass.length < 12 || pass.length > 256) throw new SetupError(400, 'Password: at least 12 characters.');
  let secret = env.ENGRAM_SESSION_SECRET && env.ENGRAM_SESSION_SECRET.length >= 32 ? env.ENGRAM_SESSION_SECRET : null;
  if (!secret) {
    await store.setnx(SECRET, b64u(globalThis.crypto.getRandomValues(new Uint8Array(48))));
    secret = await store.get(SECRET);
  }
  if (!(await store.setnx(ACCOUNTS, { [user]: await hashPassword(pass) }))) throw new SetupError(409, 'This site already has an account. Sign in instead.');
  await store.clear(failKey).catch(() => {});
  return { user, secret };
}

module.exports = { loadAuth, createFirstAccount, SetupError, normCode };
