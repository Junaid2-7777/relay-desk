import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { request as streamRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDesk } from '../src/desk.mjs';
import { openRefundFixture } from '../src/refund-fixture.mjs';
import { createDeskServer } from '../src/server.mjs';

const clock = () => new Date('2026-11-23T09:00:00+05:30');
const note = 'The practice shop said it would refund me. Can you help me check on Friday?';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-desk-context-'));
  const closers = [];
  t.after(async () => {
    await Promise.all(closers.map(close => close()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    data: name => join(directory, name),
    async open(options, port = 0) {
      const server = createDeskServer({ clock, ...options });
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
      const selectedPort = server.address().port;
      const url = `http://127.0.0.1:${selectedPort}`;
      async function close() {
        if (!server.listening) return;
        const closed = once(server, 'close');
        server.close();
        await closed;
      }
      closers.push(close);
      return {
        server, url, port: selectedPort, close,
        async request(path, { method = 'GET', context, body, status = 200 } = {}) {
          const response = await fetch(url + path, {
            method,
            headers: {
              connection: 'close',
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              ...(context === undefined ? {} : { 'X-Relay-Desk': context })
            },
            body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
          });
          const result = await response.json();
          assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
          return result;
        }
      };
    }
  };
}

test('the context survives a restart and distinguishes a copied database on the same port', async t => {
  const host = await workspace(t);
  const dataDir = host.data('original');
  const desk = await host.open({ dataDir });
  const { deskContext: context } = await desk.request('/api/desk');
  assert.match(context, /^[a-f\d]{64}$/);
  const saved = await desk.request('/api/errands', { method: 'POST', context, body: { note }, status: 201 });
  await desk.close();

  const restarted = await host.open({ dataDir }, desk.port);
  const current = await restarted.request('/api/desk');
  assert.equal(current.deskContext, context);
  assert.deepEqual(current.errands, [saved]);
  await restarted.close();

  const copied = host.data('copy');
  await cp(dataDir, copied, { recursive: true });
  const otherDesk = await host.open({ dataDir: copied }, desk.port);
  const other = await otherDesk.request('/api/desk');
  assert.notEqual(other.deskContext, context);
  assert.deepEqual(other.errands, [saved]);
  for (const path of ['/api/desk', '/api/inspect']) {
    const response = await otherDesk.request(path, { context, status: 409 });
    assert.equal(response.code, 'desk-context-changed');
    assert.ok(!JSON.stringify(response).includes(saved.note));
  }
  const path = `/api/errands/${saved.id}`;
  const edit = { revision: saved.revision, goal: 'Keep the existing refund open', checkDate: saved.checkDate };
  const stale = await otherDesk.request(path, { method: 'PUT', context, body: edit, status: 409 });
  assert.equal(stale.code, 'desk-context-changed');
  assert.deepEqual((await otherDesk.request('/api/desk')).errands, [saved]);
  const updated = await otherDesk.request(path, { method: 'PUT', context: other.deskContext, body: edit });
  assert.equal(updated.goal, edit.goal);
});

test('the context separates role and configured planner on the same port and database', async t => {
  const host = await workspace(t);
  const dataDir = host.data('shared');
  const privateDesk = await host.open({ dataDir });
  const original = await privateDesk.request('/api/desk');
  await privateDesk.close();

  const practice = await host.open({ dataDir, householdMode: true }, privateDesk.port);
  const fixed = await practice.request('/api/desk');
  assert.equal(fixed.plannerMode, 'fixed-rule');
  assert.notEqual(fixed.deskContext, original.deskContext);
  const stale = await practice.request('/api/errands', {
    method: 'POST', context: original.deskContext, body: { note, plannerMode: 'fixed-rule' }, status: 409
  });
  assert.equal(stale.code, 'desk-context-changed');
  assert.deepEqual((await practice.request('/api/desk')).errands, []);
  await practice.close();

  let plannerCalls = 0;
  const planner = { mode: 'n8n', propose() {
    plannerCalls += 1;
    return { goal: 'Check the practice refund', checkDate: null, practicePlan: null };
  } };
  const n8n = await host.open({ dataDir, householdMode: true, planner }, privateDesk.port);
  const model = await n8n.request('/api/desk');
  assert.notEqual(model.deskContext, fixed.deskContext);
  const preview = '/api/errands/preview';
  const body = { note, plannerMode: 'n8n' };
  const wrongContext = await n8n.request(preview, { method: 'POST', context: fixed.deskContext, body, status: 409 });
  assert.equal(wrongContext.code, 'desk-context-changed');
  const wrongMode = await n8n.request(preview, { method: 'POST', context: model.deskContext, body: { note }, status: 409 });
  assert.match(wrongMode.error, /planner changed/);
  assert.equal(plannerCalls, 0);
  assert.equal((await n8n.request(preview, { method: 'POST', body })).plannerMode, 'n8n');
  assert.equal(plannerCalls, 1);
});

test('a practice reset blocks stale actions for reused errand IDs and unversioned checkpoints', async t => {
  const host = await workspace(t);
  const dataDir = host.data('practice');
  const options = { dataDir, householdMode: true, reset: true };
  const originalDesk = await host.open(options);
  const original = await originalDesk.request('/api/desk');
  await originalDesk.close();

  const desk = await host.open(options, originalDesk.port);
  const current = await desk.request('/api/desk');
  assert.notEqual(current.deskContext, original.deskContext);
  assert.deepEqual(current.errands.map(record => record.id), original.errands.map(record => record.id));
  for (const [method, path] of [
    ['POST', '/api/checkpoint'], ['POST', '/api/errands/preview'],
    ['PUT', '/api/errands/demo-refund'], ['POST', '/api/errands/demo-refund/draft'],
    ['POST', '/api/errands/demo-refund/queue-followup'], ['POST', '/api/errands/demo-refund/tracking'],
    ['POST', '/api/errands/demo-refund/refund-access'], ['POST', '/api/errands/demo-refund/check-refund'],
    ['POST', '/api/errands/demo-bill/bill-choice'], ['POST', '/api/errands/demo-visit/visit-choice'],
    ['POST', '/api/errands/demo-visit/setup'], ['POST', '/api/errands/demo-visit/household-access']
  ]) {
    const result = await desk.request(path, { method, context: original.deskContext, body: {}, status: 409 });
    assert.equal(result.code, 'desk-context-changed');
  }
  assert.deepEqual((await desk.request('/api/inspect')).actions, []);
  assert.deepEqual((await desk.request('/api/fixture/visit')).attempts, []);
  assert.deepEqual((await desk.request('/api/fixture/refund')).reads, []);
  const checked = await desk.request('/api/checkpoint', { method: 'POST', context: current.deskContext, body: {} });
  assert.equal(checked.deskContext, current.deskContext);
  assert.equal((await desk.request('/api/fixture/visit')).reservations.length, 1);
});

test('a write with an incomplete body rechecks its context after another server resets the database', async t => {
  const host = await workspace(t);
  const options = { dataDir: host.data('shared'), householdMode: true, reset: true };
  const first = await host.open(options);
  const { deskContext } = await first.request('/api/desk');
  const received = once(first.server, 'request');
  let client;
  const response = new Promise((resolve, reject) => {
    client = streamRequest(`${first.url}/api/checkpoint`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Relay-Desk': deskContext }
    }, resolve);
    client.on('error', reject);
    client.setTimeout(5000, () => client.destroy(new Error('The streamed checkpoint timed out.')));
  });
  client.write('{"checkpointId":');
  await received;
  const second = await host.open(options);
  assert.notEqual((await second.request('/api/desk')).deskContext, deskContext);
  client.end('"stale-stream"}');
  const result = await response;
  const chunks = [];
  for await (const chunk of result) chunks.push(chunk);
  assert.equal(result.statusCode, 409);
  assert.equal(JSON.parse(Buffer.concat(chunks).toString()).code, 'desk-context-changed');
  assert.deepEqual((await second.request('/api/fixture/visit')).attempts, []);
});

test('a save rechecks the pinned context while holding its SQLite write lock', async t => {
  const host = await workspace(t);
  const dataDir = host.data('shared-write');
  const refundFixture = openRefundFixture({ dataDir, clock });
  const first = openDesk({ dataDir, clock, refundFixture });
  const second = openDesk({ dataDir, clock, refundFixture });
  try {
    const original = first.deskContext();
    first.withDeskContext(original, () => {
      first.checkDeskContext();
      second.resetPractice(false, refundFixture.reset);
      assert.throws(() => first.save({ note }), { status: 409, code: 'desk-context-changed' });
      assert.throws(() => first.readWithContext(first.brief), { status: 409, code: 'desk-context-changed' });
    });
    assert.notEqual(first.deskContext(), original);
    assert.deepEqual(first.brief().errands.map(record => record.id), ['demo-refund']);
  } finally {
    first.close();
    second.close();
    refundFixture.close();
  }
});

test('a planner response arriving after a reset cannot return the old review to the browser', async t => {
  const host = await workspace(t);
  const started = Promise.withResolvers();
  const proposal = Promise.withResolvers();
  const planner = { mode: 'n8n', propose() {
    started.resolve();
    return proposal.promise;
  } };
  const options = { dataDir: host.data('model'), householdMode: true, reset: true, planner };
  const first = await host.open(options);
  const { deskContext } = await first.request('/api/desk');
  const pending = first.request('/api/errands/preview', {
    method: 'POST', context: deskContext, body: { plannerMode: 'n8n', note }, status: 409
  });
  await started.promise;
  const second = await host.open(options);
  assert.notEqual((await second.request('/api/desk')).deskContext, deskContext);
  proposal.resolve({ goal: 'Check my practice refund', checkDate: null, practicePlan: null });
  const result = await pending;
  assert.equal(result.code, 'desk-context-changed');
  assert.equal(result.previewId, undefined);
});
