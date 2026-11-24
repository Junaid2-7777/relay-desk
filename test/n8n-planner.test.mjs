import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createN8nPlannerFromEnv } from '../src/n8n-planner.mjs';
import { validatePlannerProposal } from '../src/planner-proposal.mjs';
import { practiceReceiptSource } from '../src/receipt-fixture.mjs';
import { createDeskServer } from '../src/server.mjs';

const clock = () => new Date('2026-11-23T09:00:00+05:30');
const note = 'The practice library is closing my practice membership. Please look again on Friday.';
const token = 'synthetic-n8n-webhook-token';
const proposal = {
  goal: 'Check that the library closed my membership',
  checkDate: '2026-11-27',
  practicePlan: {
    capability: 'receipt', issuer: 'library-practice', subject: 'member-126', type: 'membership', status: 'closed'
  }
};

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t, handle, { household = true, timeoutMs } = {}) {
  const messages = [];
  const webhook = await listen(t, createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    messages.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    handle(response);
  }));
  const planner = createN8nPlannerFromEnv({
    RELAY_N8N_WEBHOOK_URL: `${webhook}/planner`, RELAY_N8N_WEBHOOK_TOKEN: token, RELAY_N8N_TIMEOUT_MS: timeoutMs
  });
  if (!household) assert.throws(() => createDeskServer({ planner }), /practice household/);
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-n8n-planner-'));
  const desk = await listen(t, createDeskServer({
    dataDir, clock, householdMode: household, reset: true, warm: false, planner: household ? planner : undefined
  }));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  return {
    messages,
    async request(path, body, status = 200) {
      const response = await fetch(desk + path, {
        ...(body === undefined ? {} : {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
        }),
        signal: AbortSignal.timeout(5000)
      });
      const value = await response.json();
      assert.equal(response.status, status);
      return value;
    }
  };
}

test('n8n uses ordinary intake and sends only the note, local day and source catalog before review', async t => {
  const { messages, request } = await setup(t, response => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(proposal));
  });
  const before = await request('/api/inspect');
  const { plannerMode } = await request('/api/desk');
  assert.equal(plannerMode, 'n8n');
  assert.deepEqual(messages, []);

  const preview = await request('/api/errands/preview', { note });
  assert.equal(preview.plannerMode, 'n8n');
  assert.equal(preview.plannerStatus, 'proposed');
  assert.equal(preview.goal, proposal.goal);
  assert.deepEqual(preview.practicePlan, proposal.practicePlan);
  assert.deepEqual(messages, [{
    method: 'POST', url: '/planner', authorization: `Bearer ${token}`,
    body: { note, today: '2026-11-23', sources: [practiceReceiptSource] }
  }]);
  assert.deepEqual(await request('/api/inspect'), before);

  const saved = await request('/api/errands', { note, previewId: preview.previewId }, 201);
  assert.equal(saved.plannerMode, 'n8n');
  assert.equal(saved.status, 'open');
  assert.equal(saved.checkDate, proposal.checkDate);
  assert.deepEqual(saved.practicePlan, proposal.practicePlan);
  assert.equal(messages.length, 1);
  const after = await request('/api/inspect');
  assert.deepEqual(after.grants, before.grants);
  assert.deepEqual(after.effects, before.effects);
  assert.deepEqual(after.actions, before.actions);
});

test('n8n failures fall back without returning the upstream payload or following redirects', async t => {
  const sentinel = 'untrusted-upstream-payload';
  const scenarios = [
    ['credentials rejected', 'unavailable', response => response.writeHead(401).end(sentinel)],
    ['redirect', 'unavailable', response => response.writeHead(307, { location: '/redirect-target' }).end()],
    ['malformed JSON', 'invalid-proposal', response => response.writeHead(200, { 'content-type': 'application/json' }).end(sentinel)],
    ['too large', 'invalid-proposal', response => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(sentinel.repeat(1000));
      response.end(sentinel.repeat(1000));
    }],
    ['extra authority', 'invalid-proposal', response => {
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ...proposal, grant: sentinel }));
    }]
  ];
  for (const [name, failure, handler] of scenarios) {
    await t.test(name, async t => {
      const { messages, request } = await setup(t, handler);
      const preview = await request('/api/errands/preview', { note });
      assert.equal(preview.plannerMode, 'fixed-rule');
      assert.equal(preview.plannerStatus, 'fallback');
      assert.equal(preview.plannerFailure, failure);
      assert.ok(!JSON.stringify(preview).includes(sentinel));
      assert.equal(messages.length, 1);
    });
  }
});

test('private intake stays local and the CLI rejects incompatible modes', async t => {
  const { messages, request } = await setup(t, response => response.end(), { household: false });
  const preview = await request('/api/errands/preview', { note });
  assert.equal(preview.checkDate, proposal.checkDate);
  assert.deepEqual(messages, []);

  const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  for (const [args, expected] of [[['--n8n'], /practice household/], [['--fixture', '--recorded', '--n8n'], /one practice planner/]]) {
    const result = spawnSync(process.execPath, [server, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  }
});

test('n8n configuration requires a token and restricts cleartext URLs to loopback', () => {
  assert.throws(() => createN8nPlannerFromEnv({}), /RELAY_N8N_WEBHOOK_URL/);
  const settings = { RELAY_N8N_WEBHOOK_URL: 'https://n8n.example/webhook/planner', RELAY_N8N_WEBHOOK_TOKEN: token };
  assert.throws(() => createN8nPlannerFromEnv({ ...settings, RELAY_N8N_WEBHOOK_URL: 'http://n8n.example' }), /HTTPS/);
  assert.throws(() => createN8nPlannerFromEnv({ ...settings, RELAY_N8N_WEBHOOK_TOKEN: '' }), /RELAY_N8N_WEBHOOK_TOKEN/);
  assert.throws(() => createN8nPlannerFromEnv({ ...settings, RELAY_N8N_TIMEOUT_MS: '30001' }), /RELAY_N8N_TIMEOUT_MS/);
});

test('the workflow passes one complete proposal through and rejects refusal or partial output', async () => {
  const workflow = JSON.parse(await readFile(new URL('../n8n/relay-desk-planner.json', import.meta.url)));
  const { parameters: { jsCode } } = workflow.nodes.find(node => node.name === 'Read proposal');
  const readProposal = new Function('$input', jsCode);
  const items = [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }];
  const read = (status, output = items) => readProposal({ first: () => ({ json: { status, output } }) });

  assert.deepEqual(validatePlannerProposal(read('completed')[0].json), proposal);
  assert.throws(() => read('incomplete'), /one complete proposal/);
  assert.throws(() => read('completed', [{ type: 'message', content: [{ type: 'refusal', refusal: 'Synthetic refusal' }] }]),
    /one complete proposal/);
});
