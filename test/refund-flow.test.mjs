import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mondayRefund, openRefundFixture } from '../src/refund-fixture.mjs';
import { createDeskServer } from '../src/server.mjs';

const monday = '2026-11-23T03:30:00.000Z';
const friday = '2026-11-27T03:30:00.000Z';
const refund = '/api/errands/demo-refund';
const merchantScope = {
  issuer: mondayRefund.merchantIssuer,
  thread: mondayRefund.thread,
  reference: mondayRefund.reference
};
const creditScope = { account: mondayRefund.account, reference: mondayRefund.reference };

async function startDesk(t, { fixtureMode = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-refund-flow-'));
  const fixture = fixtureMode ? openRefundFixture({ dataDir }) : undefined;
  let time = monday;
  let server;
  let url;

  async function close() {
    if (!server?.listening) return;
    const closed = once(server, 'close');
    server.close();
    await closed;
  }

  async function open(reset = false) {
    await close();
    server = createDeskServer({ dataDir, fixtureMode, reset, clock: () => new Date(time) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
  }

  async function request(path, { body, status = 200 } = {}) {
    const method = body === undefined ? 'GET' : 'POST';
    const response = await fetch(url + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const detail = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${detail}`);
    return JSON.parse(detail);
  }

  t.after(async () => {
    await close();
    fixture?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await open(fixtureMode);
  return {
    fixture,
    open,
    request,
    moveTime(date) { time = date; },
    async record() { return (await request('/api/desk')).errands.find(item => item.id === 'demo-refund'); },
    inspect: () => request('/api/fixture/refund'),
    check: () => request(`${refund}/check-refund`, { body: {} }),
    access: (record, source, choice, status) => request(`${refund}/refund-access`, {
      body: { source, choice, revision: record.revision }, status
    })
  };
}

function candidate(id, fields = {}) {
  return {
    id,
    account: mondayRefund.account,
    amountMinor: mondayRefund.amountMinor,
    currency: mondayRefund.currency,
    direction: 'incoming',
    status: 'posted',
    returnReference: mondayRefund.reference,
    postedAt: monday,
    ...fields
  };
}

test('a plain desk has no provider access or refund fixture', async t => {
  const desk = await startDesk(t, { fixtureMode: false });
  assert.deepEqual((await desk.request('/api/desk')).errands, []);
  const note = 'The shop said it would refund me. Can you help me check on Friday?';
  const saved = await desk.request('/api/errands', { body: { note }, status: 201 });
  await desk.request('/api/fixture/refund', { status: 404 });
  await desk.request(`/api/errands/${saved.id}/check-refund`, { body: {}, status: 404 });
  assert.deepEqual(await desk.request('/api/inspect'), { errands: [saved], grants: [], effects: [] });
});

test('declining credits preserves the note across restart and only reads the allowed merchant thread', async t => {
  const desk = await startDesk(t);
  const saved = await desk.record();
  assert.deepEqual(await desk.check(), saved);
  assert.deepEqual((await desk.inspect()).reads, []);
  const declined = await desk.access(saved, 'credits', 'declined');
  await desk.access(saved, 'credits', 'allowed', 409);
  const allowed = await desk.access(declined, 'merchant', 'allowed');
  assert.deepEqual(allowed.refundAccess.merchant.scope, merchantScope);
  assert.equal(allowed.refundAccess.credits.status, 'declined');

  desk.moveTime(friday);
  await desk.open();
  assert.deepEqual(await desk.record(), allowed);
  const checked = await desk.check();
  assert.equal(checked.status, 'open');
  assert.equal(checked.note, saved.note);
  assert.equal(checked.checkDate, '2026-11-27');
  assert.equal(checked.merchantEvent.type, 'promise');
  assert.deepEqual(checked.evidence, []);
  assert.deepEqual(checked.checks.merchant, { checkedAt: friday, lastEventAt: checked.merchantEvent.occurredAt });
  assert.equal(checked.checks.credits, undefined);
  assert.deepEqual((await desk.inspect()).reads, [{ source: 'merchant', scope: merchantScope, checkedAt: friday }]);
});

test('a merchant promise and pending or unrelated credits leave the refund open until the exact credit posts', async t => {
  const desk = await startDesk(t);
  const merchant = await desk.access(await desk.record(), 'merchant', 'allowed');
  await desk.access(merchant, 'credits', 'allowed');
  const initial = await desk.inspect();
  const [unrelated] = initial.credits;
  assert.equal(unrelated.amountMinor, mondayRefund.amountMinor);
  assert.notEqual(unrelated.returnReference, mondayRefund.reference);
  const first = await desk.check();
  assert.equal(first.status, 'open');
  assert.equal(first.merchantEvent.type, 'promise');
  assert.deepEqual(first.evidence, []);
  assert.deepEqual(first.checks.credits, { checkedAt: monday, lastEventAt: null });
  assert.ok(!JSON.stringify(first).includes(unrelated.id));
  assert.deepEqual((await desk.inspect()).reads.map(({ source, scope }) => ({ source, scope })), [
    { source: 'merchant', scope: merchantScope },
    { source: 'credits', scope: { ...creditScope, linkedCreditIds: [] } }
  ]);

  desk.fixture.putCredit(candidate('credit-demo-pending', { status: 'pending', postedAt: null }));
  desk.moveTime(friday);
  const pending = await desk.check();
  assert.equal(pending.status, 'open');
  assert.deepEqual(pending.evidence, []);
  assert.deepEqual(pending.checks.credits, { checkedAt: friday, lastEventAt: null });

  const posted = candidate('credit-demo-pending', { postedAt: friday });
  desk.fixture.putCredit(posted);
  const verified = await desk.check();
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.evidence, [{
    source: 'credits',
    reference: posted.id,
    amountMinor: posted.amountMinor,
    currency: posted.currency,
    postedAt: posted.postedAt
  }]);
  assert.deepEqual((await desk.inspect()).credits.find(credit => credit.id === posted.id), posted);

  const completedReads = (await desk.inspect()).reads;
  await desk.open();
  assert.deepEqual(await desk.record(), verified);
  assert.deepEqual(await desk.check(), verified);
  assert.deepEqual((await desk.inspect()).reads, completedReads);
});

test('a scoped merchant link identifies a single otherwise unmatched credit', async t => {
  const desk = await startDesk(t);
  const merchant = await desk.access(await desk.record(), 'merchant', 'allowed');
  await desk.access(merchant, 'credits', 'allowed');
  const linked = candidate('credit-demo-linked', { returnReference: null });
  desk.fixture.putCredit(linked);
  desk.fixture.putCredit(candidate('credit-demo-ambiguous', { returnReference: null }));
  assert.equal((await desk.check()).status, 'open');

  const crossReference = {
    issuer: merchantScope.issuer,
    thread: merchantScope.thread,
    returnReference: merchantScope.reference,
    creditId: linked.id
  };
  desk.fixture.putLink({ ...crossReference, issuer: 'merchant-demo-wrong-issuer' });
  assert.equal((await desk.check()).status, 'open');

  desk.fixture.putLink(crossReference);
  const checked = await desk.check();
  assert.equal(checked.status, 'verified');
  assert.equal(checked.evidence[0].reference, linked.id);
  assert.deepEqual((await desk.inspect()).reads.at(-1).scope, { ...creditScope, linkedCreditIds: [linked.id] });
});

test('withdrawal and expiry each stop their source at the provider and retain the last check', async t => {
  const desk = await startDesk(t);
  const merchant = await desk.access(await desk.record(), 'merchant', 'allowed');
  const both = await desk.access(merchant, 'credits', 'allowed');
  const checked = await desk.check();
  await desk.access(checked, 'merchant', 'withdrawn');

  desk.moveTime(friday);
  await desk.open();
  const creditsOnly = await desk.check();
  assert.equal(creditsOnly.refundAccess.merchant.status, 'withdrawn');
  assert.equal(creditsOnly.refundAccess.merchant.revision, 2);
  assert.deepEqual(creditsOnly.checks.merchant, checked.checks.merchant);
  assert.deepEqual(creditsOnly.checks.credits, { checkedAt: friday, lastEventAt: null });
  assert.equal(creditsOnly.status, 'open');
  const priorReads = (await desk.inspect()).reads;
  assert.deepEqual(priorReads.map(read => read.source), ['merchant', 'credits', 'credits']);

  desk.moveTime(both.refundAccess.credits.expiresAt);
  assert.deepEqual(await desk.check(), creditsOnly);
  assert.deepEqual((await desk.inspect()).reads, priorReads);
});
