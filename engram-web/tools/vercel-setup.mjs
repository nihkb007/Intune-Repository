#!/usr/bin/env node
// Prepares the Vercel project for ENGRAM Web through the Vercel REST API (run by CI before
// deploying, or by hand). Needs VERCEL_TOKEN and VERCEL_PROJECT_ID. VERCEL_ORG_ID is optional:
// when missing it is looked up (personal account or one of the token's teams) and, in GitHub
// Actions, handed to the later deploy step. Optionally pushes the portal login (ENGRAM_USERS,
// ENGRAM_SESSION_SECRET) into the project's environment variables.
// Never prints secret values.
import fs from 'node:fs';

const { VERCEL_TOKEN: token, VERCEL_PROJECT_ID: project, ENGRAM_USERS, ENGRAM_SESSION_SECRET } = process.env;
let org = process.env.VERCEL_ORG_ID;
if (!token || !project) {
  console.log('VERCEL_TOKEN / VERCEL_PROJECT_ID not set: nothing to do.');
  process.exit(0);
}
let team = '';
const setTeam = (id) => { team = id && id.startsWith('team_') ? `teamId=${encodeURIComponent(id)}` : ''; };
setTeam(org);
const api = async (method, path, body, query = '') => {
  const qs = [team, query].filter(Boolean).join('&');
  const res = await fetch(`https://api.vercel.com${path}${qs ? `?${qs}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

if (!org) {
  // Personal account first, then each team the token can see.
  const candidates = [''];
  try { for (const t of (await api('GET', '/v2/teams')).teams || []) candidates.push(t.id); } catch {}
  for (const id of candidates) {
    setTeam(id);
    try { org = (await api('GET', `/v9/projects/${encodeURIComponent(project)}`)).accountId; break; } catch {}
  }
  if (!org) {
    console.log(`! project ${project} not found with this token. Check that VERCEL_TOKEN has access to it (or set VERCEL_ORG_ID).`);
    process.exit(1);
  }
  setTeam(org);
  console.log(`✓ project found (owner ${org})`);
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `VERCEL_ORG_ID=${org}\n`);
}

// The Vercel CLI also reads the team itself; report (don't fail) when the token can't.
if (org.startsWith('team_')) {
  try { await api('GET', `/v2/teams/${encodeURIComponent(org)}`); } catch (err) {
    console.log(`- this token can't read team ${org} (${err.message.split(': ')[0]}); deploying without it`);
  }
}

let problems = 0;
try {
  // The site lives in engram-web/ and its build reads ../engram, so files outside the root
  // directory must be included.
  await api('PATCH', `/v9/projects/${encodeURIComponent(project)}`, {
    rootDirectory: 'engram-web',
    framework: null,
    nodeVersion: '22.x',
    sourceFilesOutsideRootDirectory: true,
  });
  console.log('✓ project settings: root directory engram-web, Node 22, files outside root included');
} catch (err) {
  problems++;
  console.log(`! could not update project settings (${err.message}).\n  Set them in Vercel → Project → Settings → Build & Deployment: Root Directory = engram-web.`);
}

for (const [key, value] of Object.entries({ ENGRAM_USERS, ENGRAM_SESSION_SECRET })) {
  if (!value) { console.log(`- ${key} not provided: left as is on Vercel`); continue; }
  try {
    await api('POST', `/v10/projects/${encodeURIComponent(project)}/env`, { key, value, type: 'encrypted', target: ['production', 'preview'] }, 'upsert=true');
    console.log(`✓ ${key} set on Vercel (value hidden)`);
  } catch (err) {
    problems++;
    console.log(`! could not set ${key} (${err.message.replace(value, '***')}). Add it in Vercel → Settings → Environment Variables.`);
  }
}
// First-run setup code: the site asks for it before it lets anyone create the account. Made
// once, never printed (this repository's logs are public); read it in Vercel.
try {
  const { envs = [] } = await api('GET', `/v9/projects/${encodeURIComponent(project)}/env`);
  if (envs.some((e) => e.key === 'ENGRAM_SETUP_CODE')) console.log('✓ ENGRAM_SETUP_CODE already set');
  else {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => abc[b % 32]).join('').match(/.{4}/g).join('-');
    await api('POST', `/v10/projects/${encodeURIComponent(project)}/env`, { key: 'ENGRAM_SETUP_CODE', value: code, type: 'encrypted', target: ['production', 'preview'] });
    console.log('✓ ENGRAM_SETUP_CODE created (see Vercel → Settings → Environment Variables)');
  }
} catch (err) {
  problems++;
  console.log(`! could not check ENGRAM_SETUP_CODE (${err.message.split(': ')[0]}). The site explains how to add it by hand.`);
}

if (problems) console.log(`${problems} step(s) need a manual touch; deployment continues.`);
