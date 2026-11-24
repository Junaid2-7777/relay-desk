import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDeskServer } from '../src/server.mjs';

const note = 'The shop said it would refund me. Can you help me check on Friday?';
const monday = '2026-11-22T19:00:00.000Z';
const friday = '2026-11-26T19:00:00.000Z';

async function startDesk(dataDir, date, options) {
  const server = createDeskServer({ ...options, dataDir, clock: () => new Date(date) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function close() {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  }

  return {
    close,
    async request(path, { method = 'GET', body, status } = {}) {
      const response = await fetch(baseUrl + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const detail = await response.text();
      const description = `${method} ${path} returned ${response.status}: ${detail}`;
      if (status === undefined) {
        assert.ok(response.ok, description);
      } else {
        assert.equal(response.status, status, description);
      }
      return JSON.parse(detail);
    }
  };
}

async function startFreshDesk(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-first-use-'));
  const desks = [];
  t.after(async () => {
    await Promise.all(desks.map((desk) => desk.close()));
    await rm(dataDir, { recursive: true, force: true });
  });
  async function open(date = monday, options) {
    const desk = await startDesk(dataDir, date, options);
    desks.push(desk);
    return desk;
  }
  return { desk: await open(), open };
}

test('a refund note survives a restart with its chosen check and no outside effects', async (t) => {
  const { desk, open } = await startFreshDesk(t);
  const empty = await desk.request('/api/desk');
  assert.equal(empty.today, '2026-11-23');
  assert.deepEqual(empty.errands, []);

  const preview = await desk.request('/api/errands/preview', {
    method: 'POST',
    body: { note }
  });
  assert.equal(preview.kind, 'refund');
  assert.equal(preview.checkDate, '2026-11-27');
  assert.ok(preview.goal.trim());

  const saved = await desk.request('/api/errands', {
    method: 'POST',
    body: { note, goal: preview.goal, checkDate: preview.checkDate }
  });
  assert.equal(saved.kind, 'refund');
  assert.equal(saved.note, note);
  assert.equal(saved.goal, preview.goal);
  assert.equal(saved.status, 'open');
  assert.equal(saved.revision, 1);
  assert.equal(saved.merchantDeadline, null);
  await desk.close();

  const reopened = await open(friday);
  const current = await reopened.request('/api/desk');
  assert.equal(current.today, '2026-11-27');
  assert.deepEqual(current.errands, [saved]);
  assert.equal(current.errands[0].checkDate, '2026-11-27');

  const draft = await reopened.request(`/api/errands/${saved.id}/draft`, { method: 'POST' });
  assert.ok(draft.text.trim());
  const inspection = await reopened.request('/api/inspect');
  assert.deepEqual(inspection.errands, [saved]);
  assert.deepEqual(inspection.grants, []);
  assert.deepEqual(inspection.effects, []);
});

test('private follow-up updates survive restart while the original errand and its evidence stay intact', async t => {
  const { desk, open } = await startFreshDesk(t);
  const errand = await desk.request('/api/errands', { method: 'POST', body: { note } });
  const path = `/api/errands/${errand.id}`;
  const history = `${path}/updates`;
  const first = { requestId: randomUUID(), text: ' The shop said the transfer should arrive on Tuesday.\n' };
  assert.deepEqual(await desk.request(history), { updates: [] });
  const saved = await desk.request(history, { method: 'POST', body: first, status: 201 });
  assert.deepEqual(saved, { id: first.requestId, text: first.text, recordedAt: monday });
  await desk.close();
  const reopened = await open(friday);
  const second = { requestId: randomUUID(), text: 'I still cannot see the credit.' };
  const next = await reopened.request(history, { method: 'POST', body: second, status: 201 });
  assert.equal(next.recordedAt, friday);
  assert.deepEqual(await reopened.request(history), { updates: [saved, next] });
  assert.deepEqual(await reopened.request('/api/inspect'), { errands: [errand], grants: [], effects: [] });
  const stopped = await reopened.request(`${path}/tracking`, { method: 'POST', body: { choice: 'stop', revision: errand.revision } });
  assert.deepEqual(await reopened.request(history, { method: 'POST', body: first, status: 201 }), saved);
  const third = { requestId: randomUUID(), text: 'I spoke with the shop again.' };
  await reopened.request(history, { method: 'POST', body: third, status: 409 });
  assert.deepEqual(await reopened.request(history), { updates: [saved, next] });
  await reopened.request(`${path}/tracking`, { method: 'POST', body: { choice: 'resume', revision: stopped.revision } });
  await reopened.request(history, { method: 'POST', body: third, status: 201 });
  assert.equal((await reopened.request(history)).updates.length, 3);
});

test('concurrent private updates append once per request and never enter the practice desk', async t => {
  const { desk, open } = await startFreshDesk(t);
  const rival = await open();
  const create = note => desk.request('/api/errands', { method: 'POST', body: { note } });
  const a = await create(note);
  const b = await create('Call about the delivery.');
  const path = id => `/api/errands/${id}/updates`;
  const post = (client, id, body, status) => client.request(path(id), { method: 'POST', body, status });
  const first = { requestId: randomUUID(), text: 'They expect to reply next week.' };
  const second = { requestId: randomUUID(), text: 'I saved the receipt.' };
  const [saved, other, replay] = await Promise.all([
    post(desk, a.id, first, 201), post(rival, a.id, second, 201),
    post(rival, a.id, { ...first, requestId: first.requestId.toUpperCase() }, 201)
  ]);
  assert.deepEqual(saved, replay);
  assert.deepEqual(new Set((await rival.request(path(a.id))).updates.map(entry => entry.id)), new Set([saved.id, other.id]));
  const conflict = await post(desk, b.id, first, 409);
  assert.ok(!JSON.stringify(conflict).includes(first.text));
  await post(desk, a.id, { ...first, text: 'Changed words.' }, 409);
  for (const body of [{ text: 'Missing ID.' }, { requestId: randomUUID(), text: '  ' }, { requestId: randomUUID(), text: 'a'.repeat(2001) }]) {
    await post(desk, b.id, body, 400);
  }
  assert.deepEqual(await desk.request(path(b.id)), { updates: [] });
  const practice = await open(monday, { householdMode: true, reset: true });
  await practice.request(path(a.id), { status: 404 });
  await post(practice, a.id, second, 404);
  await post(practice, 'demo-refund', second, 404);
  await desk.request(path('demo-refund'), { status: 404 });
  assert.deepEqual((await desk.request(path(a.id))).updates.length, 2);
});

test('editing a saved errand preserves the original note and rejects a stale edit', async (t) => {
  const { desk } = await startFreshDesk(t);
  const saved = await desk.request('/api/errands', {
    method: 'POST',
    body: { note, goal: 'Check the shop refund', checkDate: '2026-11-27' }
  });
  const path = `/api/errands/${saved.id}`;
  const edited = await desk.request(path, {
    method: 'PUT',
    body: { goal: 'Ask when the refund will post', checkDate: '2026-11-30', revision: saved.revision }
  });
  assert.equal(edited.id, saved.id);
  assert.equal(edited.goal, 'Ask when the refund will post');
  assert.equal(edited.note, note);
  assert.equal(edited.checkDate, '2026-11-30');
  assert.equal(edited.revision, 2);
  assert.equal(edited.status, 'open');
  assert.equal(edited.merchantDeadline, null);

  await desk.request(path, {
    method: 'PUT',
    body: { goal: 'An older draft', checkDate: '2026-11-27', revision: saved.revision },
    status: 409
  });
  assert.deepEqual((await desk.request('/api/desk')).errands, [edited]);

  const cleared = await desk.request(path, {
    method: 'PUT',
    body: { goal: edited.goal, checkDate: null, revision: edited.revision }
  });
  assert.equal(cleared.checkDate, null);
  assert.equal(cleared.note, note);

  const inspection = await desk.request('/api/inspect');
  assert.deepEqual(inspection.errands, [cleared]);
  assert.deepEqual(inspection.effects, []);
});

test('private follow-up drafts preserve exact words across restart and stop without changing the errand', async t => {
  const { desk, open } = await startFreshDesk(t);
  const errand = await desk.request('/api/errands', { method: 'POST', body: { note } });
  const path = `/api/errands/${errand.id}`;
  const read = client => client.request(`${path}/draft`, { method: 'POST' });
  const save = (client, body, status) => client.request(`${path}/local-draft`, { method: 'PUT', body, status });
  const generated = await read(desk);
  assert.equal(generated.draftRevision, 0);
  assert.match(generated.text, /check the status of the refund/);
  assert.deepEqual(await read(desk), generated);

  const body = { text: ' Hello,\n\nCould you share the refund reference?\n ', draftRevision: 0 };
  const saved = { ...body, draftRevision: 1 };
  assert.deepEqual(await save(desk, body), saved);
  assert.deepEqual(await save(desk, body), saved);
  assert.deepEqual(await save(desk, saved), saved);
  assert.deepEqual((await desk.request('/api/desk')).errands, [errand]);

  const rival = await open();
  const conflict = await save(rival, { ...body, text: 'An older copy from another tab' }, 409);
  assert.equal(conflict.code, 'local-draft-conflict');
  assert.deepEqual(await read(rival), saved);
  await save(rival, { ...saved, text: '   \n' }, 400);
  await save(rival, { ...saved, text: 'a'.repeat(8001) }, 400);
  await save(rival, { text: saved.text, draftRevision: 1.5 }, 400);
  assert.deepEqual(await read(rival), saved);

  const update = await save(rival, { text: 'Please check again on Thursday.', draftRevision: 1 });
  const restored = await save(desk, { text: saved.text, draftRevision: 2 });
  assert.equal(update.draftRevision, 2);
  assert.deepEqual(restored, { text: saved.text, draftRevision: 3 });
  await save(rival, body, 409);
  await desk.close();
  await rival.close();

  const reopened = await open(friday);
  assert.deepEqual(await read(reopened), restored);
  assert.deepEqual((await reopened.request('/api/desk')).errands, [errand]);
  const stopped = await reopened.request(`${path}/tracking`, { method: 'POST', body: { choice: 'stop', revision: errand.revision } });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.note, note);
  assert.deepEqual(await read(reopened), restored);
  const inspection = await reopened.request('/api/inspect');
  assert.deepEqual(inspection, { errands: [stopped], grants: [], effects: [] });
  await reopened.request(`${path}/queue-followup`, { method: 'POST', body: restored, status: 404 });
});

test('the private brief brings the earliest open check back to the top after an edit or stop', async t => {
  const { desk } = await startFreshDesk(t);
  const save = (note, checkDate) => desk.request('/api/errands', { method: 'POST', body: { note, checkDate } });
  const old = await save('Look for the returned deposit', '2026-11-22');
  const today = await save('Pick up a parcel', '2026-11-23');
  const later = await save('Check the membership', '2026-11-28');
  const undated = await save('Ask about the key', null);
  const ids = async () => (await desk.request('/api/desk')).errands.map(row => row.id);
  assert.deepEqual(await ids(), [old.id, today.id, later.id, undated.id]);
  await desk.request(`/api/errands/${old.id}/tracking`, { method: 'POST', body: { choice: 'stop', revision: old.revision } });
  await desk.request(`/api/errands/${later.id}`, { method: 'PUT', body: { goal: later.goal, checkDate: '2026-11-21', revision: later.revision } });
  assert.deepEqual(await ids(), [later.id, today.id, undated.id, old.id]);
  assert.deepEqual((await desk.request('/api/inspect')).effects, []);
});

test('a retried save keeps one errand across date rollover and edits', async (t) => {
  const { desk, open } = await startFreshDesk(t);
  const body = { note: 'Can you check tomorrow?', requestId: '553bf795-b0a3-4f15-b10a-9317e8546fdc' };
  const saved = await desk.request('/api/errands', { method: 'POST', body });
  assert.equal(saved.checkDate, '2026-11-24');
  await desk.close();

  const reopened = await open(friday);
  const save = (fields, status) => reopened.request('/api/errands', { method: 'POST', body: fields, status });
  assert.deepEqual(await save(body), saved);
  const edited = await reopened.request(`/api/errands/${saved.id}`, {
    method: 'PUT', body: { goal: 'Ask for the outcome', checkDate: '2026-11-30', revision: saved.revision }
  });
  assert.deepEqual(await save(body), edited);
  await save({ ...body, checkDate: null }, 409);
  assert.deepEqual((await reopened.request('/api/desk')).errands, [edited]);
});
