#!/usr/bin/env node
'use strict';
// Generates a realistic, fully synthetic two-account Claude Code history for demos,
// screenshots and end-to-end tests. Nothing here is real usage.
//   demo/home/.claude            -> account "ops"      (work)
//   demo/home/.claude-personal   -> account "personal"
//   demo/data/engram.json        -> seeded vault (accounts + notes)

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(__dirname, '..', 'demo');

let seed = 1337;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => Math.floor(lo + rnd() * (hi - lo + 1));
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.floor(rnd() * 16);
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

const PROJECTS = [
  {
    name: 'Intune-Repository', dir: '/home/nihko/code/Intune-Repository', weight: 5, acct: 'ops',
    files: ['Intune_SetPrimaryUser', 'README.md', 'modules/Graph.psm1', 'tests/SetPrimaryUser.Tests.ps1', 'config/exceptions.json'],
    prompts: [
      'Add Azure group exception support to Intune_SetPrimaryUser so skipped users never get reassigned',
      'The Graph paging breaks after 1000 devices, fix the nextLink loop',
      'Write Pester tests for the primary user resolution logic',
      'Improve logging: rotate log files daily and include device serial',
      'Why does the script throw 429 on large tenants? add retry with backoff',
      'Refactor the sign-in log lookup into its own function',
    ],
    errors: ['Invoke-MgGraphRequest: Response status code does not indicate success: 429 (Too Many Requests).', 'Pester: Expected 3, but got 2 in "resolves most frequent user"'],
    cmds: ['Invoke-Pester -Path tests', 'pwsh ./Intune_SetPrimaryUser -WhatIf', 'git status', 'git diff --stat'],
  },
  {
    name: 'neon-storefront', dir: '/home/nihko/code/neon-storefront', weight: 4, acct: 'personal',
    files: ['src/app/checkout/page.tsx', 'src/lib/stripe.ts', 'src/components/Cart.tsx', 'prisma/schema.prisma', 'tests/checkout.spec.ts'],
    prompts: [
      'Build the checkout flow with Stripe payment intents and a success page',
      'Cart total is off by one cent on discounted items, find the rounding bug',
      'Add Playwright e2e for checkout happy path',
      'Migrate product images to next/image with blur placeholders',
      'Set up the Prisma schema for orders and line items',
    ],
    errors: ['Type error: Property \'amount_total\' does not exist on type \'PaymentIntent\'.', 'Error: P2002 Unique constraint failed on the fields: (`sku`)'],
    cmds: ['pnpm test', 'pnpm build', 'pnpm prisma migrate dev', 'pnpm exec playwright test'],
  },
  {
    name: 'quant-signals', dir: '/home/nihko/code/quant-signals', weight: 3, acct: 'personal',
    files: ['signals/momentum.py', 'signals/backtest.py', 'data/loader.py', 'tests/test_backtest.py', 'notebooks/explore.ipynb'],
    prompts: [
      'Implement a vectorized momentum signal with a 20/100 crossover',
      'The backtest has look-ahead bias, audit the shift() calls',
      'Add transaction cost modelling to the backtester',
      'Speed up the loader, parquet reads take 40 seconds',
    ],
    errors: ['KeyError: \'adj_close\'', 'AssertionError: sharpe ratio 3.91 is implausible — look-ahead suspected'],
    cmds: ['pytest -q', 'python -m signals.backtest --from 2019', 'ruff check .'],
  },
  {
    name: 'homelab-infra', dir: '/home/nihko/code/homelab-infra', weight: 2, acct: 'ops',
    files: ['terraform/main.tf', 'ansible/site.yml', 'k8s/traefik.yaml', 'docs/network.md'],
    prompts: [
      'Write Terraform for the Proxmox VMs with cloud-init',
      'Traefik is not issuing certs for the wildcard domain, debug it',
      'Add an Ansible role that hardens SSH on every node',
    ],
    errors: ['Error: acme: error presenting token: cloudflare: failed to find zone', 'terraform: Error: Unsupported argument "disk_size"'],
    cmds: ['terraform plan', 'ansible-playbook -i inventory site.yml --check', 'kubectl get pods -A'],
  },
  {
    name: 'engram', dir: '/home/nihko/code/engram', weight: 2, acct: 'ops',
    files: ['src/core/scanner.js', 'src/renderer/app.js', 'src/renderer/styles.css', 'test/unit/pricing.test.js'],
    prompts: [
      'Build the cost scanner that dedupes streamed assistant messages',
      'Add the FUSION capsule generator',
      'Make the neon grid background run at 60fps',
    ],
    errors: ['TypeError: Cannot read properties of undefined (reading \'usage\')'],
    cmds: ['npm test', 'npm run dist:win'],
  },
];

const MODELS = [
  { id: 'claude-opus-5-5', w: 5 },
  { id: 'claude-opus-5', w: 3 },
  { id: 'claude-sonnet-5', w: 4 },
  { id: 'claude-fable-5-1', w: 1 },
];
const weighted = (arr, key = 'w') => {
  const total = arr.reduce((a, x) => a + x[key], 0);
  let r = rnd() * total;
  for (const x of arr) { if ((r -= x[key]) <= 0) return x; }
  return arr[arr.length - 1];
};

const OUTCOMES = [
  'Done. All tests pass and the change is committed on the feature branch.',
  'Fixed — the root cause was an off-by-one in the paging loop; added a regression test.',
  'Implemented and verified locally. Left a TODO for the edge case with empty groups.',
  'The build is green. I updated the README with the new flags.',
  'Refactor complete; behaviour unchanged, 14 tests cover the new function.',
];

function writeSession(configDir, project, startTs, opts = {}) {
  const sid = uuid();
  const slug = project.dir.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(configDir, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  let t = startTs;
  const model = weighted(MODELS).id;
  const turns = int(3, 9);
  let parent = null;
  let ctx = int(9000, 22000);
  const base = { sessionId: sid, cwd: project.dir, gitBranch: pick(['main', 'feat/checkout', 'fix/paging', 'dev']), version: '2.1.283', isSidechain: false, userType: 'external' };
  const push = (o) => { const uid = uuid(); lines.push(JSON.stringify({ ...base, parentUuid: parent, uuid: uid, timestamp: new Date(t).toISOString(), ...o })); parent = uid; };

  for (let i = 0; i < turns; i++) {
    const prompt = i === 0 ? pick(project.prompts) : pick(['continue', 'run the tests again', 'looks good, now commit it', 'also update the docs', pick(project.prompts)]);
    push({ type: 'user', message: { role: 'user', content: prompt } });
    t += int(2, 20) * 1000;
    const steps = int(2, 6);
    for (let k = 0; k < steps; k++) {
      const msgId = 'msg_' + uuid().replace(/-/g, '').slice(0, 24);
      const req = 'req_' + uuid().replace(/-/g, '').slice(0, 24);
      const out = int(180, 2400);
      const write = k === 0 ? int(1500, 9000) : int(0, 1800);
      const usage = {
        input_tokens: int(2, 40), output_tokens: out,
        cache_creation_input_tokens: write, cache_read_input_tokens: ctx,
        cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 },
        service_tier: 'standard',
      };
      ctx += write + int(200, 1500);
      const toolKind = pick(['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Read', 'Edit']);
      const toolId = 'toolu_' + uuid().replace(/-/g, '').slice(0, 22);
      const file = path.join(project.dir, pick(project.files));
      const input = toolKind === 'Bash' ? { command: pick(project.cmds), description: 'Run project checks' }
        : toolKind === 'Grep' ? { pattern: pick(['TODO', 'nextLink', 'amount', 'shift\\(', 'retry']), path: project.dir }
          : toolKind === 'Edit' ? { file_path: file, old_string: 'a', new_string: 'b' }
            : { file_path: file };
      // One API message streamed as two lines (text + tool_use) sharing the same usage — the scanner must count it once.
      push({ type: 'assistant', requestId: req, message: { id: msgId, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: pick(['Let me look at that.', 'Checking the current implementation.', 'Running the tests.', 'Applying the fix.']) }], usage } });
      push({ type: 'assistant', requestId: req, message: { id: msgId, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: toolId, name: toolKind, input }], usage } });
      t += int(3, 40) * 1000;
      const isErr = rnd() < 0.045;
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isErr, content: isErr ? pick(project.errors) : 'ok' }] } });
      t += int(1, 6) * 1000;
    }
    // Occasional subagent on Haiku.
    if (rnd() < 0.07) {
      const msgId = 'msg_' + uuid().replace(/-/g, '').slice(0, 24);
      lines.push(JSON.stringify({ ...base, isSidechain: true, parentUuid: parent, uuid: uuid(), timestamp: new Date(t).toISOString(), type: 'assistant', requestId: 'req_' + uuid().slice(0, 8), message: { id: msgId, role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Found 3 matching call sites.' }], usage: { input_tokens: int(2000, 8000), output_tokens: int(100, 600), cache_creation_input_tokens: 0, cache_read_input_tokens: int(0, 4000) } } }));
    }
    const msgId = 'msg_' + uuid().replace(/-/g, '').slice(0, 24);
    push({ type: 'assistant', requestId: 'req_' + uuid().slice(0, 8), message: { id: msgId, role: 'assistant', model, content: [{ type: 'text', text: pick(OUTCOMES) }], usage: { input_tokens: 3, output_tokens: int(120, 700), cache_creation_input_tokens: int(200, 1200), cache_read_input_tokens: ctx } } });
    t += int(30, 600) * 1000;
  }
  if (opts.summary) lines.unshift(JSON.stringify({ type: 'summary', summary: opts.summary, leafUuid: parent }));
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const at = new Date(t);
  fs.utimesSync(file, at, at);
  return { sid, file, end: t };
}

function main(ROOT = DEFAULT_ROOT) {
  const HOME = path.join(ROOT, 'home');
  const DATA = path.join(ROOT, 'data');
  seed = 1337;
  fs.rmSync(ROOT, { recursive: true, force: true });
  const SHARED = path.join(ROOT, 'shared-folder');
  // Real (empty) checkouts with git remotes, so the laptops can match projects by repo.
  const checkout = (base, p) => {
    const dir = path.join(base, 'code', p.name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = git@github.com:nihko/${p.name}.git\n`);
    return dir;
  };
  for (const p of PROJECTS) p.dir = checkout(HOME, p);
  const acctDirs = { ops: path.join(HOME, '.claude'), personal: path.join(HOME, '.claude-personal') };
  for (const [k, d] of Object.entries(acctDirs)) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${k === 'ops' ? 'nihko.ops' : 'nihko'}@example.dev`, organizationName: k === 'ops' ? 'Ops Team' : 'Personal', billingType: k === 'ops' ? 'max' : 'pro' } }, null, 2));
  }

  const now = Date.now();
  const DAYS = 48;
  let count = 0;
  for (let d = DAYS; d >= 0; d--) {
    const dayStart = now - d * 86400000;
    const weekday = new Date(dayStart).getDay();
    const busy = weekday === 0 || weekday === 6 ? 0.8 : 2.4;
    const n = Math.max(0, Math.round(busy * (0.4 + rnd() * 1.2) * (1 + (DAYS - d) / DAYS)));
    for (let i = 0; i < n; i++) {
      const project = weighted(PROJECTS, 'weight');
      const acct = rnd() < 0.8 ? project.acct : (project.acct === 'ops' ? 'personal' : 'ops');
      const hour = weekday === 0 || weekday === 6 ? int(11, 23) : pick([9, 10, 11, 13, 14, 15, 16, 20, 21, 22]);
      const start = new Date(dayStart);
      start.setHours(hour, int(0, 59), int(0, 59), 0);
      if (start.getTime() > now - 3600000) start.setTime(now - int(2, 10) * 3600000);
      writeSession(acctDirs[acct], project, start.getTime(), { summary: rnd() < 0.5 ? project.prompts[0].split(',')[0] : null });
      count++;
    }
  }

  fs.mkdirSync(DATA, { recursive: true });
  const nowIso = new Date().toISOString();
  const note = (id, o) => ({ id, tags: [], scope: 'project', kind: 'note', pinned: false, createdAt: nowIso, updatedAt: nowIso, ...o });
  const store = {
    version: 1,
    createdAt: nowIso,
    accounts: [
      { id: 'a_ops', name: 'OPS // work', configDir: acctDirs.ops, color: '#00f0ff', email: 'nihko.ops@example.dev', plan: 'max' },
      { id: 'a_personal', name: 'GHOST // personal', configDir: acctDirs.personal, color: '#ff2bd6', email: 'nihko@example.dev', plan: 'pro' },
    ],
    activeAccountId: 'a_ops',
    notes: [
      note('n_1', { title: 'Never reassign users in the exceptions group', kind: 'directive', pinned: true, project: 'git:github.com/nihko/Intune-Repository'.toLowerCase(), tags: ['intune', 'safety'], body: 'Members of **SG-Intune-PrimaryUser-Exempt** must be skipped before any Graph PATCH. The script must log the skip with the device serial.\n\n- Check group membership *before* resolving sign-ins\n- `-WhatIf` must never call Graph write endpoints' }),
      note('n_2', { title: 'Graph throttling strategy', kind: 'decision', project: 'git:github.com/nihko/Intune-Repository'.toLowerCase(), tags: ['graph', 'performance'], body: 'We honour `Retry-After` and fall back to exponential backoff (2s → 32s, 5 attempts). Batch requests of 20 max.\n\n```powershell\nInvoke-WithRetry { Invoke-MgGraphRequest @params }\n```' }),
      note('n_3', { title: 'Money is integer cents', kind: 'directive', pinned: true, project: 'git:github.com/nihko/neon-storefront'.toLowerCase(), tags: ['payments'], body: 'All prices are stored and computed as integer cents. Only format at the UI edge. This fixed the one-cent discount bug.' }),
      note('n_4', { title: 'Always shift signals by one bar', kind: 'lesson', project: 'git:github.com/nihko/quant-signals'.toLowerCase(), tags: ['backtest'], body: 'Any signal computed on close must be `.shift(1)` before joining returns, or the backtest has look-ahead bias (Sharpe 3.9 was fake).' }),
      note('n_5', { title: 'House style for every project', kind: 'directive', scope: 'global', pinned: true, project: null, tags: ['global'], body: 'Run the test suite before claiming done. Small commits with imperative messages. Never commit secrets or `.env` files.' }),
      note('n_6', { title: 'Traefik wildcard certs', kind: 'lesson', project: 'git:github.com/nihko/homelab-infra'.toLowerCase(), tags: ['dns'], body: 'Cloudflare token needs **Zone:Read** on all zones, not just DNS edit — otherwise ACME fails with "failed to find zone".' }),
      note('n_7', { title: 'Release checklist', kind: 'note', project: 'git:github.com/nihko/engram'.toLowerCase(), tags: ['release'], body: '1. `npm test`\n2. `npm run test:e2e`\n3. `npm run dist:win`\n4. Tag and push' }),
    ],
    capsules: [],
    bridgeLedger: {},
    recordings: {},
    settings: { monthlyBudget: 200, currency: 'USD', pricingOverrides: {}, autoArchive: true, effects: 'full', injectOnFuse: false,
      sync: { folder: SHARED, machineId: 'm_personal', machineName: 'PERSONAL-LAPTOP', mode: 'full' } },
  };
  fs.writeFileSync(path.join(DATA, 'engram.json'), JSON.stringify(store, null, 2));

  // A second laptop (the work laptop) with its own Claude account, pushed into the shared
  // folder by the real sync code, exactly as ENGRAM on that laptop would.
  const WORK = path.join(ROOT, 'work-laptop');
  const workAcctDir = path.join(WORK, '.claude');
  const workProjects = PROJECTS.filter((p) => ['Intune-Repository', 'homelab-infra'].includes(p.name)).map((p) => ({ ...p, dir: checkout(WORK, p) }));
  let remoteCount = 0;
  for (let d = 30; d >= 0; d--) {
    const weekday = new Date(now - d * 86400000).getDay();
    if (weekday === 0 || weekday === 6) continue;
    for (let i = 0; i < int(0, 2); i++) {
      const start = new Date(now - d * 86400000);
      start.setHours(pick([8, 9, 10, 11, 14, 15, 16]), int(0, 59), 0, 0);
      if (start.getTime() > now - 3600000) start.setTime(now - int(3, 12) * 3600000);
      writeSession(workAcctDir, pick(workProjects), start.getTime());
      remoteCount++;
    }
  }
  const { Store } = require('../src/core/store');
  const { Scanner } = require('../src/core/scanner');
  const sync = require('../src/core/sync');
  const ws = new Store(path.join(WORK, 'vault'));
  ws.data.settings.sync = { folder: SHARED, machineId: 'm_worklaptop', machineName: 'WORK-LAPTOP', mode: 'full', codeRoots: [path.join(WORK, 'code')] };
  ws.upsertAccount({ id: 'a_corp', name: 'CORP // work', configDir: workAcctDir, color: '#00f0ff', email: 'nihko@corp.example' });
  ws.upsertNote({ title: 'Change freeze on Fridays', kind: 'directive', scope: 'global', pinned: true, body: 'No production Intune assignments on Fridays after 12:00. Stage in the pilot ring instead.' });
  const wsc = new Scanner({ store: ws, dataDir: path.join(WORK, 'vault') });
  sync.exportMachine(ws, wsc.scan(), SHARED);
  ws.save(true);
  console.log(`demo: ${count} sessions on this laptop (2 accounts) + ${remoteCount} on WORK-LAPTOP, ${PROJECTS.length} projects -> ${ROOT}`);
}

if (require.main === module) main();
module.exports = { main, DEFAULT_ROOT };
