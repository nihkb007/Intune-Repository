#!/usr/bin/env node
'use strict';
// Creates the ENGRAM_USERS value for a portal login, and a session secret.
//   npm run make-user -- <name>        (asks for the password, input hidden)
const readline = require('readline');
const crypto = require('crypto');
const { hashPassword } = require('../lib/auth');

const name = (process.argv[2] || '').trim().toLowerCase();
if (!/^[a-z0-9._-]{2,64}$/.test(name)) { console.error('Usage: npm run make-user -- <name>   (letters, digits, . _ -)'); process.exit(1); }

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const pw = process.env.ENGRAM_NEW_PASSWORD || await ask('Password (12+ characters): ');
  if (pw.length < 12) { console.error('Use at least 12 characters.'); process.exit(1); }
  const again = process.env.ENGRAM_NEW_PASSWORD || await ask('Repeat password: ');
  if (pw !== again) { console.error('Passwords do not match.'); process.exit(1); }
  console.log('\nAdd these two Environment Variables to the Vercel project (Settings → Environment Variables):\n');
  console.log(`ENGRAM_USERS=${name}:${await hashPassword(pw)}`);
  console.log(`ENGRAM_SESSION_SECRET=${crypto.randomBytes(32).toString('base64url')}`);
  console.log('\nTo add another person later, append ",name:hash" to ENGRAM_USERS.');
})();
