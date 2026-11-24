import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createDeskServer } from '../src/server.mjs';

const script = fileURLToPath(new URL('../scripts/observe-session.mjs', import.meta.url));
const run = promisify(execFile);
const clock = () => new Date('2026-11-23T09:00:00+05:30');

async function open(t, mode, readClock = clock) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-observer-'));
  const server = createDeskServer({ dataDir, clock: readClock, householdMode: mode !== 'private', reset: mode !== 'private', warm: mode === 'warm' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    await closed;
    await rm(dataDir, { recursive: true, force: true });
  });
  const { port } = server.address();
  const http = [];
  server.on('request', request => http.push([request.method, request.url]));
  return {
    http,
    async request(path, body, status = 200) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.equal(response.status, status, path);
      return response.json();
    },
    async observe() {
      const { stdout } = await run(process.execPath, [script], { env: { ...process.env, RELAY_PORT: String(port) } });
      return JSON.parse(stdout);
    }
  };
}

test('observing private first use prints the next check with no note, private identifier or provider request', async t => {
  const desk = await open(t, 'private');
  const note = 'Check the synthetic personal reference moonstone-478 on Friday.';
  const saved = await desk.request('/api/errands', { note, goal: 'Private synthetic goal', checkDate: '2026-11-27' }, 201);
  desk.http.length = 0;
  const report = await desk.observe();
  assert.deepEqual(report.errands, [{
    kind: 'errand', status: 'open', checkDate: '2026-11-27', permissions: {}, decisionReady: null, matchedNativeEvidence: {}
  }]);
  assert.equal(report.desk, 'private');
  assert.equal(report.planner, 'fixed-rule');
  assert.deepEqual(desk.http, [['GET', '/api/desk'], ['GET', '/api/desk']]);
  assert.ok(Object.values(report.providerReads).every(count => count === 0));
  assert.ok(Object.values(report.committedEffects).every(count => count === 0));
  assert.ok([note, saved.goal, saved.id, 'moonstone-478'].every(item => !JSON.stringify(report).includes(item)));
});

test('the observer tracks mandatory bill choices across approval expiry and payment withdrawal', async t => {
  let now = clock();
  const desk = await open(t, 'warm', () => now);
  const bill = (await desk.request('/api/checkpoint', {})).errands.find(record => record.kind === 'bill');
  const route = `/api/errands/${bill.id}`;
  const readiness = async () => (await desk.observe()).errands.find(record => record.kind === 'bill').decisionReady;
  assert.equal(await readiness(), 'bill-review');

  const approved = await desk.request(`${route}/bill-choice`, { revision: bill.revision, choice: 'approve' });
  assert.equal(await readiness(), null);
  assert.deepEqual((await desk.request('/api/fixture/bill')).payments, []);
  now = new Date(approved.approval.expiresAt);
  assert.equal(await readiness(), 'bill-review');

  const held = await desk.request(`${route}/household-access`, {
    revision: approved.revision, operation: 'payment', choice: 'withdrawn'
  });
  assert.equal(await readiness(), null);
  await desk.request(`${route}/bill-choice`, { revision: held.revision, choice: 'approve' }, 409);
  const deferred = await desk.request(`${route}/bill-choice`, { revision: held.revision, choice: 'defer' });
  assert.equal(deferred.issue, 'bill-deferred');
  assert.deepEqual((await desk.request('/api/fixture/bill')).payments, []);
});

test('the observer distinguishes cold grants from warm native outcomes without executing a checkpoint', async t => {
  for (const mode of ['cold', 'warm']) {
    const desk = await open(t, mode);
    const initial = await desk.request('/api/desk');
    if (mode === 'cold') {
      for (const [kind, path, choice] of [
        ['visit', 'household-access', { operation: 'freeBusy', choice: 'allowed' }],
        ['refund', 'refund-access', { source: 'credits', choice: 'declined' }]
      ]) {
        const errand = initial.errands.find(item => item.kind === kind);
        await desk.request(`/api/errands/${errand.id}/${path}`, { ...choice, revision: errand.revision });
      }
    }
    await desk.request('/api/checkpoint', {});
    const prior = await desk.request('/api/fixture/visit');
    desk.http.length = 0;
    const report = await desk.observe();
    assert.ok(desk.http.every(([method]) => method === 'GET'));
    assert.deepEqual(await desk.request('/api/fixture/visit'), prior);
    assert.equal(report.desk, 'practice-household');
    assert.equal(report.providerReads.freeBusy, 1);
    assert.equal(report.writeAttempts.payments, 0);
    assert.equal(report.committedEffects.payments, 0);
    const visit = report.errands.find(item => item.kind === 'visit');
    const refund = report.errands.find(item => item.kind === 'refund');
    assert.equal(visit.permissions.freeBusy, 'allowed');
    assert.equal(report.providerReads.credits, mode === 'warm' ? 1 : 0);
    assert.equal(refund.permissions.credits, mode === 'warm' ? 'allowed' : 'declined');
    assert.equal(report.committedEffects.reservations, mode === 'warm' ? 1 : 0);
    assert.deepEqual(visit.matchedNativeEvidence, mode === 'warm' ? { reservation: true, calendar: true } : {});
    assert.equal(report.errands.find(item => item.kind === 'bill').decisionReady, mode === 'warm' ? 'bill-review' : null);
    assert.ok(!JSON.stringify(report).includes('Synthetic private calendar title'));
  }
});

test('a reset during observation yields a failure without a partial report', async t => {
  const server = createServer((request, response) => {
    const first = request.headers['x-relay-desk'] === undefined;
    response.writeHead(first ? 200 : 409, { 'content-type': 'application/json' });
    response.end(JSON.stringify(first ? { deskContext: 'first', household: true, errands: [] } : { error: 'private-upstream-marker' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, RELAY_PORT: String(server.address().port) };
  await assert.rejects(run(process.execPath, [script], { env }), error =>
    error.code === 1 && error.stdout === '' && /desk changed/.test(error.stderr) && !error.stderr.includes('private-upstream-marker'));
});

test('a provider change with the same desk revision yields no observation', async t => {
  let inspections = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/desk') {
      response.end(JSON.stringify({ deskContext: 'same', fixture: true, household: false, errands: [] }));
    } else if (request.url === '/api/fixture/refund') {
      response.end(JSON.stringify({ reads: [], links: [], credits: [{ id: 'private-credit-' + ++inspections }] }));
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, RELAY_PORT: String(server.address().port) };
  await assert.rejects(run(process.execPath, [script], { env }), error =>
    error.code === 1 && error.stdout === '' && /provider record changed/.test(error.stderr) && !error.stderr.includes('private-credit'));
  assert.equal(inspections, 2);
});
