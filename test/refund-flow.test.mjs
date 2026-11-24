import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mondayRefund, openRefundFixture } from '../src/refund-fixture.mjs';
import { createDeskServer } from '../src/server.mjs';

const monday = '2026-11-23T03:30:00.000Z';
const tuesday = '2026-11-24T03:30:00.000Z';
const wednesday = '2026-11-25T03:30:00.000Z';
const friday = '2026-11-27T03:30:00.000Z';
const refund = '/api/errands/demo-refund';
const merchantScope = {
  issuer: mondayRefund.merchantIssuer,
  thread: mondayRefund.thread,
  reference: mondayRefund.reference
};
const creditScope = { account: mondayRefund.account, reference: mondayRefund.reference };
const run = promisify(execFile);
const evidenceScript = fileURLToPath(new URL('../scripts/demo-evidence.mjs', import.meta.url));

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
    async operator(...args) {
      const { stdout } = await run(process.execPath, [evidenceScript, ...args], {
        env: { ...process.env, RELAY_DATA_DIR: dataDir, RELAY_CLOCK: time }, windowsHide: true
      });
      return JSON.parse(stdout);
    },
    async record() { return (await request('/api/desk')).errands.find(item => item.id === 'demo-refund'); },
    inspect: () => request('/api/fixture/refund'),
    check: checkpointId => request(`${refund}/check-refund`, { body: { checkpointId } }),
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
  assert.deepEqual(checked.checks.merchant, { checkedAt: friday, lastEventAt: checked.merchantEvent.occurredAt, status: 'checked' });
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
  assert.deepEqual(first.checks.credits, { checkedAt: monday, lastEventAt: null, status: 'checked' });
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
  assert.deepEqual(pending.checks.credits, { checkedAt: friday, lastEventAt: null, status: 'checked' });

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

test('operator credits and issuer links require a fresh allowed check on both refund feeds', async t => {
  const desk = await startDesk(t);
  const merchant = await desk.access(await desk.record(), 'merchant', 'allowed');
  const ready = await desk.access(merchant, 'credits', 'allowed');
  await assert.rejects(desk.operator('refund-link-credit', 'credit-a', 'merchant'), /Publish the unlinked practice credit first/u);
  await assert.rejects(desk.operator('refund-offline', 'other'), /Choose merchant or credits/u);
  const posted = await desk.operator('refund-unlinked-credit', 'credit-a');
  assert.deepEqual(posted, candidate('demo-unlinked-refund-credit-a', { returnReference: null }));
  assert.deepEqual(await desk.record(), ready);
  assert.deepEqual((await desk.inspect()).reads, []);
  const single = await desk.check('single-unlinked');
  assert.equal(single.status, 'open');
  assert.deepEqual(single.evidence, []);

  const twin = await desk.operator('refund-unlinked-credit', 'credit-b');
  assert.deepEqual(twin, { ...posted, id: 'demo-unlinked-refund-credit-b' });
  const ambiguous = await desk.check('two-unlinked');
  assert.equal(ambiguous.status, 'open');
  assert.deepEqual(ambiguous.evidence, []);

  const exactLink = {
    issuer: merchantScope.issuer,
    thread: merchantScope.thread,
    returnReference: merchantScope.reference,
    creditId: posted.id
  };
  const wrongLink = await desk.operator('refund-link-credit', 'credit-a', 'unrelated');
  assert.deepEqual(wrongLink, { ...exactLink, issuer: 'merchant-demo-unrelated' });
  const wrong = await desk.check('wrong-issuer');
  assert.equal(wrong.status, 'open');
  const preOutage = await desk.inspect();
  assert.deepEqual(preOutage.reads.at(-1).scope, { ...creditScope, linkedCreditIds: [] });

  desk.moveTime(tuesday);
  assert.deepEqual(await desk.operator('refund-offline', 'merchant'), { source: 'merchant', available: false });
  assert.deepEqual(await desk.operator('refund-link-credit', 'credit-a', 'merchant'), exactLink);
  assert.deepEqual(await desk.operator('refund-link-credit', 'credit-a', 'merchant'), exactLink);
  assert.deepEqual(await desk.operator('refund-unlinked-credit', 'credit-a'), posted);
  const published = await desk.inspect();
  assert.deepEqual(published.links, [exactLink, wrongLink]);
  assert.deepEqual(published.reads, preOutage.reads);
  assert.deepEqual(await desk.record(), wrong);

  const shopOutage = await desk.check('merchant-offline');
  assert.equal(shopOutage.status, 'open');
  assert.equal(shopOutage.checks.merchant.checkedAt, wrong.checks.merchant.checkedAt);
  assert.equal(shopOutage.checks.merchant.status, 'unavailable');
  const merchantUnavailable = { source: 'merchant', scope: merchantScope, checkedAt: tuesday, status: 'unavailable' };
  assert.deepEqual((await desk.inspect()).reads.slice(-3), [merchantUnavailable, merchantUnavailable, {
    source: 'credits', scope: { ...creditScope, linkedCreditIds: [] }, checkedAt: tuesday
  }]);

  desk.moveTime(wednesday);
  assert.deepEqual(await desk.operator('refund-online', 'merchant'), { source: 'merchant', available: true });
  assert.deepEqual(await desk.operator('refund-offline', 'credits'), { source: 'credits', available: false });
  const ledgerOutage = await desk.check('credits-offline');
  assert.equal(ledgerOutage.status, 'open');
  assert.deepEqual(ledgerOutage.evidence, []);
  assert.equal(ledgerOutage.checks.credits.checkedAt, shopOutage.checks.credits.checkedAt);
  assert.equal(ledgerOutage.checks.credits.status, 'unavailable');
  const ledgerUnavailable = {
    source: 'credits', scope: { ...creditScope, linkedCreditIds: [posted.id] }, checkedAt: wednesday, status: 'unavailable'
  };
  const outageReads = (await desk.inspect()).reads;
  assert.deepEqual(outageReads.slice(-3), [
    { source: 'merchant', scope: merchantScope, checkedAt: wednesday }, ledgerUnavailable, ledgerUnavailable
  ]);

  assert.deepEqual(await desk.operator('refund-online', 'credits'), { source: 'credits', available: true });
  assert.deepEqual(await desk.check('credits-offline'), ledgerOutage);
  assert.deepEqual((await desk.inspect()).reads, outageReads);
  await desk.access(ledgerOutage, 'merchant', 'withdrawn');
  const creditsOnly = await desk.check('credit-without-issuer-grant');
  assert.equal(creditsOnly.status, 'open');
  assert.deepEqual((await desk.inspect()).reads.slice(outageReads.length), [{
    source: 'credits', scope: { ...creditScope, linkedCreditIds: [] }, checkedAt: wednesday
  }]);

  desk.moveTime(friday);
  await desk.access(creditsOnly, 'merchant', 'allowed');
  const checked = await desk.check('both-restored');
  assert.equal(checked.status, 'verified');
  assert.deepEqual(checked.evidence, [{
    source: 'credits', reference: posted.id, amountMinor: posted.amountMinor, currency: posted.currency, postedAt: posted.postedAt
  }]);
  const proof = await desk.inspect();
  assert.deepEqual(proof.reads.slice(-2), [
    { source: 'merchant', scope: merchantScope, checkedAt: friday },
    { source: 'credits', scope: { ...creditScope, linkedCreditIds: [posted.id] }, checkedAt: friday }
  ]);
  assert.deepEqual(proof.credits.filter(credit => credit.returnReference === null), [posted, twin]);
  assert.deepEqual((await desk.request('/api/inspect')).effects, proof.reads);
});

test('refund activity follows issuer instants and ignores malformed evidence', async t => {
  const desk = await startDesk(t);
  const merchant = await desk.access(await desk.record(), 'merchant', 'allowed');
  await desk.access(merchant, 'credits', 'allowed');
  const terms = {
    issuer: merchantScope.issuer, thread: merchantScope.thread, returnReference: merchantScope.reference
  };
  const earlier = '2026-11-26T20:00:00+05:30';
  const latest = '2026-11-26T15:00:00Z';
  const lastUpdate = { ...terms, id: 'latest-update', type: 'acknowledgement', occurredAt: latest };
  desk.fixture.putEvent({ ...terms, id: 'older-update', type: 'promise', occurredAt: earlier });
  desk.fixture.putEvent(lastUpdate);
  desk.fixture.putCredit(candidate('older-credit', { amountMinor: 1000, postedAt: earlier }));
  desk.fixture.putCredit(candidate('latest-credit', { amountMinor: 1000, postedAt: latest }));

  desk.moveTime(friday);
  const checked = await desk.check();
  assert.deepEqual(checked.merchantEvent, lastUpdate);
  assert.equal(checked.checks.merchant.lastEventAt, latest);
  assert.equal(checked.checks.credits.lastEventAt, latest);

  desk.fixture.putEvent({ ...terms, id: 'invalid-update', type: 'promise', occurredAt: 'invalid-provider-time' });
  desk.fixture.putCredit(candidate('ambiguous-credit', { postedAt: '2026-11-27T10:00:00' }));
  desk.fixture.putCredit(candidate('impossible-credit', { postedAt: '2026-11-31T10:00:00Z' }));
  const unchanged = await desk.check();
  assert.equal(unchanged.status, 'open');
  assert.deepEqual(unchanged.evidence, []);
  assert.deepEqual(unchanged.merchantEvent, lastUpdate);
  assert.equal(unchanged.checks.merchant.lastEventAt, latest);
  assert.equal(unchanged.checks.credits.lastEventAt, latest);

  const posted = candidate('matched-credit', { postedAt: friday });
  desk.fixture.putCredit(posted);
  const verified = await desk.check();
  assert.equal(verified.status, 'verified');
  assert.equal(verified.evidence[0].postedAt, posted.postedAt);
  assert.equal(verified.checks.credits.lastEventAt, posted.postedAt);
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
  assert.deepEqual(creditsOnly.checks.credits, { checkedAt: friday, lastEventAt: null, status: 'checked' });
  assert.equal(creditsOnly.status, 'open');
  const priorReads = (await desk.inspect()).reads;
  assert.deepEqual(priorReads.map(read => read.source), ['merchant', 'credits', 'credits']);

  desk.moveTime(both.refundAccess.credits.expiresAt);
  assert.deepEqual(await desk.check(), creditsOnly);
  assert.deepEqual((await desk.inspect()).reads, priorReads);
});

test('a quiet checkpoint advances the check time and a disconnected feed retries once across replay', async t => {
  const desk = await startDesk(t);
  const merchant = await desk.access(await desk.record(), 'merchant', 'allowed');
  await desk.access(merchant, 'credits', 'allowed');
  desk.fixture.putCredit(candidate('credit-demo-partial', { amountMinor: 1000 }));
  const first = await desk.check('quiet-start');
  assert.equal(first.status, 'open');
  assert.deepEqual(first.checks.credits, {
    checkedAt: monday, lastEventAt: monday, status: 'checked', checkpointId: 'quiet-start'
  });

  desk.moveTime(tuesday);
  const quiet = await desk.check('quiet-next');
  assert.deepEqual(quiet.checks.credits, {
    checkedAt: tuesday, lastEventAt: monday, status: 'checked', checkpointId: 'quiet-next'
  });
  assert.equal(quiet.checks.merchant.lastEventAt, first.checks.merchant.lastEventAt);

  const unrelatedMarker = 'private-synthetic-record-outside-grant';
  desk.fixture.putCredit(candidate(unrelatedMarker, { returnReference: 'return-demo-unrelated' }));
  desk.fixture.setAvailable('credits', false);
  desk.moveTime(wednesday);
  await desk.open();
  const outage = await desk.check('outage');
  assert.equal(outage.status, 'open');
  assert.equal(outage.owner, quiet.owner);
  assert.deepEqual(outage.merchantEvent, quiet.merchantEvent);
  assert.equal(outage.checks.merchant.checkedAt, wednesday);
  assert.deepEqual(outage.checks.credits, {
    checkedAt: tuesday, lastEventAt: monday, status: 'unavailable', checkpointId: 'outage'
  });
  const outageTrace = (await desk.inspect()).reads;
  const failedRead = {
    source: 'credits',
    scope: { ...creditScope, linkedCreditIds: [] },
    checkedAt: wednesday,
    status: 'unavailable'
  };
  assert.deepEqual(outageTrace.slice(-3), [
    { source: 'merchant', scope: merchantScope, checkedAt: wednesday },
    failedRead,
    failedRead
  ]);
  assert.ok(!JSON.stringify(outageTrace).includes(unrelatedMarker));
  assert.ok(!JSON.stringify(outage).includes(unrelatedMarker));

  await desk.open();
  assert.deepEqual(await desk.check('outage'), outage);
  assert.deepEqual((await desk.inspect()).reads, outageTrace);

  desk.fixture.setAvailable('credits', true);
  desk.moveTime(friday);
  const restored = await desk.check('restored');
  assert.deepEqual(restored.checks.credits, {
    checkedAt: friday, lastEventAt: monday, status: 'checked', checkpointId: 'restored'
  });
  const restoredTrace = (await desk.inspect()).reads;
  assert.equal(restoredTrace.length, outageTrace.length + 2);
  assert.deepEqual(await desk.check('outage'), restored);
  assert.deepEqual((await desk.inspect()).reads, restoredTrace);
});

test('credit verification can continue while the last known merchant event is retained', async t => {
  const desk = await startDesk(t);
  const merchant = await desk.access(await desk.record(), 'merchant', 'allowed');
  await desk.access(merchant, 'credits', 'allowed');
  const first = await desk.check('initial');

  desk.fixture.setAvailable('merchant', false);
  desk.fixture.putCredit(candidate('credit-demo-during-merchant-outage', { postedAt: friday }));
  desk.moveTime(friday);
  const verified = await desk.check('merchant-outage');
  assert.equal(verified.status, 'verified');
  assert.equal(verified.owner, first.owner);
  assert.deepEqual(verified.merchantEvent, first.merchantEvent);
  assert.deepEqual(verified.checks.merchant, {
    checkedAt: monday,
    lastEventAt: first.checks.merchant.lastEventAt,
    status: 'unavailable',
    checkpointId: 'merchant-outage'
  });
  assert.equal(verified.evidence[0].reference, 'credit-demo-during-merchant-outage');
  assert.deepEqual((await desk.inspect()).reads.slice(-3).map(read => [read.source, read.status]), [
    ['merchant', 'unavailable'],
    ['merchant', 'unavailable'],
    ['credits', undefined]
  ]);
});

test('two disconnected sources share one automatic retry in a checkpoint', async t => {
  const desk = await startDesk(t);
  const merchant = await desk.access(await desk.record(), 'merchant', 'allowed');
  await desk.access(merchant, 'credits', 'allowed');
  desk.fixture.setAvailable('merchant', false);
  desk.fixture.setAvailable('credits', false);

  const checked = await desk.check('both-out');
  assert.equal(checked.status, 'open');
  for (const source of ['merchant', 'credits']) {
    assert.deepEqual(checked.checks[source], {
      checkedAt: null, lastEventAt: null, status: 'unavailable', checkpointId: 'both-out'
    });
  }
  assert.deepEqual((await desk.inspect()).reads.map(read => [read.source, read.status]), [
    ['merchant', 'unavailable'],
    ['merchant', 'unavailable'],
    ['credits', 'unavailable']
  ]);
});
