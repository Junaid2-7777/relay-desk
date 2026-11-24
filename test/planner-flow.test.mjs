import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createIntakePlanner } from '../src/intake-planner.mjs';
import { practiceReceiptSource } from '../src/receipt-fixture.mjs';
import { createDeskServer } from '../src/server.mjs';

const note = 'I asked the practice library to close my membership. Can you help me check on Friday?';
const clock = () => new Date('2026-11-23T03:30:00.000Z');
const proposal = {
  goal: 'Confirm my practice membership has closed', checkDate: '2026-11-27',
  practicePlan: {
    capability: 'receipt', issuer: practiceReceiptSource.issuer, subject: 'practice-member-126', type: 'membership', status: 'closed'
  }
};

test('reviewed proposals keep their original plan when a caller edits a returned draft', async () => {
  const planner = createIntakePlanner({ mode: 'recorded-response', propose: () => proposal });
  const reviewed = await planner.review(note, '2026-11-23', [practiceReceiptSource], { kind: 'errand' });
  reviewed.practicePlan.subject = 'different-errand';
  const original = planner.reviewed(reviewed.previewId, note);
  assert.deepEqual(original.practicePlan, proposal.practicePlan);
  original.practicePlan.subject = 'another-errand';
  assert.deepEqual(planner.reviewed(reviewed.previewId, note).practicePlan, proposal.practicePlan);
});

async function start(t, planner, householdMode = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-planner-flow-'));
  let server;
  let url;

  async function close() {
    if (!server?.listening) return;
    const closed = once(server, 'close');
    server.close();
    await closed;
  }

  async function open(reset) {
    await close();
    server = createDeskServer({ dataDir, clock, householdMode, reset, warm: false, planner });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
  }

  async function request(path, body, expectedStatus = 200) {
    const method = body === undefined ? 'GET' : 'POST';
    const response = await fetch(url + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const detail = await response.text();
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${detail}`);
    return JSON.parse(detail);
  }

  t.after(async () => {
    await close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await open(true);

  return {
    preview: draft => request('/api/errands/preview', { note: draft }),
    save: (draft, status = 201) => request('/api/errands', draft, status),
    setup: (errand, plan) => request(`/api/errands/${errand.id}/setup`, { ...plan, revision: errand.revision }),
    inspect: () => request('/api/inspect'),
    native: () => Promise.all(['refund', 'bill', 'visit', 'receipt', 'outbox'].map(source => request(`/api/fixture/${source}`))),
    restart: () => open(false)
  };
}

test('a recorded proposal survives ordinary save without another planner call, permission or provider effect', async t => {
  const calls = [];
  const desk = await start(t, { mode: 'recorded-response', async propose(input) { calls.push(input); return proposal; } });
  const before = await desk.inspect();
  const providers = await desk.native();

  const preview = await desk.preview(note);
  assert.equal(preview.goal, proposal.goal);
  assert.equal(preview.checkDate, proposal.checkDate);
  assert.deepEqual(preview.practicePlan, proposal.practicePlan);
  assert.equal(preview.plannerMode, 'recorded-response');
  assert.equal(preview.plannerStatus, 'proposed');
  assert.ok(preview.previewId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].note, note);
  assert.equal(calls[0].today, '2026-11-23');
  assert.deepEqual(calls[0].sources, [practiceReceiptSource]);
  assert.ok(calls[0].signal instanceof AbortSignal);

  assert.deepEqual(await desk.inspect(), before);
  assert.deepEqual(await desk.native(), providers);

  const confirmed = {
    note, goal: 'Check that my membership is closed', checkDate: preview.checkDate,
    previewId: preview.previewId, requestId: '6eb3a5da-0626-4b41-b7f5-b9001217b7b4'
  };
  await desk.save({ ...confirmed, note: 'Another errand entirely' }, 409);
  const saved = await desk.save(confirmed);
  assert.equal(saved.note, note);
  assert.equal(saved.goal, confirmed.goal);
  assert.equal(saved.checkDate, confirmed.checkDate);
  assert.equal(saved.status, 'open');
  assert.equal(saved.plannerMode, 'recorded-response');
  assert.deepEqual(saved.practicePlan, proposal.practicePlan);
  assert.deepEqual(saved.grants ?? {}, {});
  assert.equal(calls.length, 1);

  const after = await desk.inspect();
  assert.equal(after.errands.length, before.errands.length + 1);
  assert.deepEqual(after.grants, before.grants);
  assert.deepEqual(after.effects, before.effects);
  assert.deepEqual(after.actions, before.actions);
  assert.deepEqual(await desk.native(), providers);

  await desk.restart();
  assert.deepEqual(await desk.save(confirmed), saved);
  assert.equal(calls.length, 1);
});

test('saving the original review can be retried after agreeing its plan and restarting', async t => {
  let candidate = proposal;
  const desk = await start(t, { mode: 'recorded-response', propose: () => candidate });
  const { previewId } = await desk.preview(note);
  const request = { note, previewId, requestId: 'a141b37d-99e1-438a-a224-08cfb5d78b17' };
  const saved = await desk.save(request);
  const agreed = await desk.setup(saved, saved.practicePlan);
  assert.equal(agreed.receiptPlan.subject, saved.practicePlan.subject);
  assert.deepEqual(await desk.save(request), agreed);

  candidate = { ...proposal, practicePlan: { ...proposal.practicePlan, subject: 'different-member' } };
  const alternate = await desk.preview(note);
  await desk.save({ ...request, previewId: alternate.previewId }, 409);
  await desk.restart();
  assert.deepEqual(await desk.save(request), agreed);
  await desk.save({ ...request, previewId: alternate.previewId }, 409);
});

test('an invalid recorded proposal falls back without carrying an authority field or its value', async t => {
  const desk = await start(t, {
    mode: 'recorded-response', async propose() {
      return { ...proposal, practicePlan: { ...proposal.practicePlan, grant: 'synthetic-forged-authority' } };
    }
  });
  const before = await desk.inspect();
  const preview = await desk.preview(note);
  assert.equal(preview.plannerMode, 'fixed-rule');
  assert.equal(preview.plannerStatus, 'fallback');
  assert.equal(preview.plannerFailure, 'invalid-proposal');
  assert.equal(preview.checkDate, '2026-11-27');
  assert.ok(!JSON.stringify(preview).includes('synthetic-forged-authority'));
  assert.deepEqual(await desk.inspect(), before);
});

test('a planner can leave the proof unspecified and the person can still agree an exact plan', async t => {
  const desk = await start(t, {
    mode: 'recorded-response', async propose() {
      return { ...proposal, practicePlan: null };
    }
  });
  const native = await desk.native();
  const preview = await desk.preview(note);
  const saved = await desk.save({ note, previewId: preview.previewId });
  assert.equal(saved.practicePlan, null);

  const confirmed = await desk.setup(saved, proposal.practicePlan);
  assert.equal(confirmed.kind, 'receipt');
  assert.equal(confirmed.receiptPlan.subject, proposal.practicePlan.subject);
  assert.equal(confirmed.issue, 'receipt-permission');
  assert.deepEqual(confirmed.grants, {});
  assert.deepEqual(await desk.native(), native);
});

test('a timed-out recorded proposal falls back and aborts the candidate', { timeout: 5000 }, async t => {
  let candidateSignal;
  const desk = await start(t, {
    mode: 'recorded-response', timeoutMs: 15,
    async propose({ signal }) {
      candidateSignal = signal;
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return proposal;
    }
  });
  const preview = await desk.preview(note);
  assert.equal(preview.plannerMode, 'fixed-rule');
  assert.equal(preview.plannerStatus, 'fallback');
  assert.equal(preview.plannerFailure, 'timeout');
  assert.equal(preview.checkDate, '2026-11-27');
  assert.ok(candidateSignal.aborted);
});

test('private first use refuses candidate configuration and continues with local intake', async t => {
  let calls = 0;
  const planner = { mode: 'recorded-response', async propose() { calls += 1; return proposal; } };
  await assert.rejects(() => start(t, planner, false), /practice household/);
  const desk = await start(t, undefined, false);
  const refund = 'The shop said it would refund me. Can you help me check on Friday?';
  const preview = await desk.preview(refund);
  assert.equal(preview.kind, 'refund');
  assert.equal(preview.checkDate, '2026-11-27');
  const saved = await desk.save({ note: refund, goal: preview.goal, checkDate: preview.checkDate });
  assert.equal(saved.note, refund);
  assert.equal(saved.status, 'open');
  assert.equal(calls, 0);
  assert.deepEqual((await desk.inspect()).grants, []);
  assert.deepEqual((await desk.inspect()).effects, []);
});
