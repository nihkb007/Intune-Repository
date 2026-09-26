#!/usr/bin/env node
// Prepares the Vercel project for ENGRAM Web through the Vercel REST API (run by CI before
// deploying, or by hand). Needs VERCEL_TOKEN and VERCEL_PROJECT_ID; VERCEL_ORG_ID when the
// project belongs to a team. Optionally pushes the portal login (ENGRAM_USERS,
// ENGRAM_SESSION_SECRET) into the project's environment variables.
// Never prints secret values.
const { VERCEL_TOKEN: token, VERCEL_PROJECT_ID: project, VERCEL_ORG_ID: org, ENGRAM_USERS, ENGRAM_SESSION_SECRET } = process.env;
if (!token || !project) {
  console.log('VERCEL_TOKEN / VERCEL_PROJECT_ID not set: nothing to do.');
  process.exit(0);
}
const team = org && org.startsWith('team_') ? `teamId=${encodeURIComponent(org)}` : '';
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
if (problems) console.log(`${problems} step(s) need a manual touch; deployment continues.`);
