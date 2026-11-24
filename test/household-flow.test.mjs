import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { matchedReadbacks } from '../scripts/compare-planners.mjs';
import { mondayBill, openBillFixture } from '../src/bill-fixture.mjs';
import { openOutboxFixture } from '../src/outbox-fixture.mjs';
import { openReceiptFixture, practiceReceiptSource } from '../src/receipt-fixture.mjs';
import { mondayRefund, openRefundFixture } from '../src/refund-fixture.mjs';
import { createDeskServer } from '../src/server.mjs';
import { mondayVisit, openVisitFixture } from '../src/visit-fixture.mjs';

const monday = '2026-11-23T03:30:00.000Z';
const tuesday = '2026-11-24T03:30:00.000Z';
const visitStart = '2026-11-24T15:00:00+05:30';
const visitEnd = '2026-11-24T16:00:00+05:30';
const billCap = 90000;
const requestedAmount = 118000;

async function startHousehold(t, warm = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-household-flow-'));
  const connections = [];
  let time = monday;
  let server;
  let url;
  const clock = () => new Date(typeof time === 'function' ? time() : time);

  async function close() {
    if (!server?.listening) return;
    const closed = once(server, 'close');
    server.close();
    await closed;
  }

  async function open(reset = false) {
    await close();
    server = createDeskServer({ dataDir, clock, householdMode: true, reset, warm });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
  }

  async function request(path, body, status = 200) {
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
    for (const connection of connections) connection.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await open(true);
  return {
    request,
    async restart(nextTime = time, reset = false) {
      time = nextTime;
      await open(reset);
    },
    moveTime(next) { time = next; },
    operator(args, status = 0) {
      const run = spawnSync(process.execPath, ['scripts/demo-evidence.mjs', ...args], {
        cwd: new URL('../', import.meta.url), encoding: 'utf8',
        env: { ...process.env, RELAY_DATA_DIR: dataDir, RELAY_CLOCK: time }
      });
      assert.equal(run.status, status, run.stderr);
      return status === 0 ? JSON.parse(run.stdout) : run.stderr;
    },
    persistLegacyErrand(record) {
      const database = new DatabaseSync(join(dataDir, 'desk.sqlite'));
      try {
        database.prepare('UPDATE errands SET record = ? WHERE id = ?').run(JSON.stringify(record), record.id);
      } finally {
        database.close();
      }
    },
    provider(openFixture) {
      const connection = openFixture({ dataDir, clock });
      connections.push(connection);
      return connection;
    },
    desk: () => request('/api/desk'),
    checkpoint: () => request('/api/checkpoint', {}),
    inspect: () => request('/api/inspect'),
    native: provider => request(`/api/fixture/${provider}`),
    access: (errand, operation, choice, status) => request(`/api/errands/${errand.id}/household-access`, {
      operation, choice, revision: errand.revision
    }, status),
    refundAccess: (errand, source, choice, status) => request(`/api/errands/${errand.id}/refund-access`, {
      source, choice, revision: errand.revision
    }, status),
    tracking: (errand, choice) => request(`/api/errands/${errand.id}/tracking`, {
      choice, revision: errand.revision
    }),
    draft: errand => request(`/api/errands/${errand.id}/draft`, {}),
    queue: (errand, terms, status) => request(`/api/errands/${errand.id}/queue-followup`, { revision: errand.revision, ...terms }, status),
    billChoice: (errand, choice, status) => request('/api/errands/demo-bill/bill-choice', {
      choice, revision: errand.revision
    }, status),
    visitChoice: (errand, choice, status) => request(`/api/errands/${errand.id}/visit-choice`, {
      choice, revision: errand.revision
    }, status)
  };
}

function errand(brief, kind) {
  const record = brief.errands.find(item => item.id === `demo-${kind}`);
  assert.ok(record, `Missing ${kind} errand`);
  return record;
}

test('a reopened desk cannot use future standing grants or spend an exact approval before it was given', async t => {
  const household = await startHousehold(t);
  const before = '2026-11-23T03:29:59.999Z';
  await household.restart(before);
  const early = await household.checkpoint();
  assert.equal(errand(early, 'visit').issue, 'visit-permission');
  assert.equal(errand(early, 'bill').issue, 'bill-permission');
  for (const provider of ['refund', 'visit', 'bill']) assert.equal((await household.native(provider)).reads.length, 0);
  assert.equal((await household.native('visit')).reservations.length, 0);

  await household.restart(monday);
  const bill = errand(await household.checkpoint(), 'bill');
  const approvalTime = '2026-11-23T03:35:00.000Z';
  household.moveTime(approvalTime);
  await household.billChoice(bill, 'approve');
  await household.restart('2026-11-23T03:34:59.999Z');
  await household.checkpoint();
  assert.equal((await household.native('bill')).attempts.length, 0);
  await household.restart(approvalTime);
  assert.equal(errand(await household.checkpoint(), 'bill').status, 'accepted');
  assert.equal((await household.native('bill')).payments.length, 1);
});

test('posted credits, issuer receipts and settlements verify only once their event time arrives', async t => {
  const household = await startHousehold(t);
  const request = { note: 'Look for confirmation from the practice library.' };
  const saved = await household.request('/api/errands', request, 201);
  const receipt = { issuer: practiceReceiptSource.issuer, subject: 'library-record-12', type: 'receipt', status: 'closed' };
  const planned = await household.request(`/api/errands/${saved.id}/setup`, { revision: saved.revision, capability: 'receipt', ...receipt });
  await household.access(planned, 'receipt', 'allowed');
  const bill = errand(await household.checkpoint(), 'bill');
  await household.billChoice(bill, 'approve');
  const paid = errand(await household.checkpoint(), 'bill').payment;
  const future = '2026-11-24T09:00:00+05:30';
  const credit = { id: 'tuesday-credit', ...mondayRefund, returnReference: mondayRefund.reference,
    direction: 'incoming', status: 'posted', postedAt: future };
  const refund = household.provider(openRefundFixture);
  refund.putCredit(credit);
  refund.putEvent({ id: 'tuesday-update', issuer: mondayRefund.merchantIssuer, thread: mondayRefund.thread,
    returnReference: mondayRefund.reference, occurredAt: future, type: 'promise' });
  household.provider(openReceiptFixture).putReceipt({ ...receipt, id: 'tuesday-closure', occurredAt: future });
  household.provider(openBillFixture).putSettlement({ ...paid, status: 'settled', settledAt: future });

  const early = await household.checkpoint();
  const earlyRefund = errand(early, 'refund');
  assert.equal(earlyRefund.status, 'open');
  assert.notEqual(earlyRefund.merchantEvent?.id, 'tuesday-update');
  assert.notEqual(earlyRefund.checks.credits.lastEventAt, future);
  assert.equal(early.errands.find(item => item.id === saved.id).receiptCheck.lastEventAt, null);
  assert.equal(early.errands.find(item => item.id === saved.id).status, 'open');
  assert.equal(errand(early, 'bill').status, 'accepted');
  const earlyNative = {};
  for (const source of ['bill', 'receipt', 'refund']) earlyNative[source] = await household.native(source);
  household.moveTime(tuesday);
  const timely = await household.checkpoint();
  assert.equal(errand(timely, 'refund').evidence[0].reference, credit.id);
  assert.equal(timely.errands.find(item => item.id === saved.id).receiptProof.id, 'tuesday-closure');
  assert.equal(errand(timely, 'bill').settlement.settledAt, future);
  assert.equal((await household.native('bill')).attempts.length, 1);
  const futureRefund = { ...errand(timely, 'refund'), checks: earlyRefund.checks };
  const futureReceipt = { ...timely.errands.find(item => item.id === saved.id), receiptCheck: { checkedAt: monday } };
  assert.equal(matchedReadbacks(futureRefund, earlyNative).credit, false);
  assert.equal(matchedReadbacks(futureReceipt, earlyNative).receipt, false);
  assert.equal(matchedReadbacks(errand(timely, 'bill'), earlyNative).settlement, false);
});

test('the warm household brings one bill decision, books the free visit and keeps the refund open', async t => {
  const household = await startHousehold(t);
  const before = await household.native('visit');
  assert.equal(before.reservations.length, 0);
  assert.equal(before.calendar.length, 1);
  const [protectedEvent] = before.calendar;
  const brief = await household.checkpoint();

  const bill = errand(brief, 'bill');
  assert.equal(brief.errands[0].id, bill.id);
  assert.equal(bill.issue, 'bill-review');
  assert.equal(bill.previousInvoice.amountMinor, 85000);
  assert.equal(bill.invoice.amountMinor, requestedAmount);
  assert.equal(bill.invoice.revision, 2);
  assert.equal(bill.invoice.payee, mondayBill.payee);
  assert.equal(bill.capMinor, billCap);
  assert.equal(bill.grants.payment.scope.capMinor, billCap);
  assert.deepEqual((await household.native('bill')).payments, []);
  assert.deepEqual((await household.native('bill')).attempts, []);

  const visit = errand(brief, 'visit');
  assert.equal(visit.status, 'verified');
  const native = await household.native('visit');
  assert.equal(native.reservations.length, 1);
  assert.equal(native.calendar.length, 2);
  const [reservation] = native.reservations;
  assert.deepEqual(visit.reservation, reservation);
  assert.equal(reservation.status, 'confirmed');
  assert.equal(reservation.feeMinor, 0);
  assert.equal(reservation.start, visitStart);
  assert.equal(reservation.end, visitEnd);
  const event = native.calendar.find(item => item.reservationId === reservation.id);
  assert.ok(event);
  assert.equal(visit.calendarEvent.id, event.id);
  assert.equal(event.start, reservation.start);
  assert.equal(event.end, reservation.end);
  assert.equal(event.zone, reservation.zone);
  assert.deepEqual(native.calendar.find(item => item.id === protectedEvent.id), protectedEvent);

  const refund = errand(brief, 'refund');
  assert.equal(refund.status, 'open');
  assert.ok(refund.refund.reference);
  assert.equal(refund.merchantEvent.type, 'promise');
  assert.deepEqual(refund.evidence, []);
  assert.equal(brief.errands.filter(item => item.issue === 'bill-review' || item.issue === 'calendar-conflict').length, 1);
  const inspection = await household.inspect();
  assert.deepEqual(inspection.actions.map(({ operation, status }) => ({ operation, status })), [
    { operation: 'reserve', status: 'confirmed' },
    { operation: 'calendar', status: 'recorded' }
  ]);
  assert.ok(!JSON.stringify({ brief, inspection }).includes(protectedEvent.title));
});

test('the cold household reads only the allowed free/busy interval and leaves all writes untouched', async t => {
  const household = await startHousehold(t, false);
  const cold = await household.desk();
  assert.deepEqual((await household.inspect()).grants, []);
  await household.access(errand(cold, 'visit'), 'freeBusy', 'allowed');
  await household.refundAccess(errand(cold, 'refund'), 'credits', 'declined');
  const after = await household.checkpoint();
  assert.equal(errand(after, 'visit').status, 'open');
  assert.equal(errand(after, 'bill').status, 'open');
  const refund = errand(after, 'refund');
  assert.equal(refund.status, 'open');
  assert.equal(refund.refundAccess.credits.status, 'declined');
  assert.equal(refund.note, errand(cold, 'refund').note);
  assert.deepEqual((await household.native('refund')).reads, []);
  assert.deepEqual((await household.native('bill')).payments, []);
  const visit = await household.native('visit');
  assert.deepEqual(visit.reservations, []);
  assert.deepEqual(visit.attempts, []);
  assert.equal(visit.calendar.length, 1);
  assert.deepEqual(visit.reads.map(({ source, scope }) => ({ source, scope })), [{
    source: 'freeBusy', scope: { start: mondayVisit.windowStart, end: mondayVisit.windowEnd }
  }]);
  assert.deepEqual((await household.inspect()).actions, []);
});

test('a one-time approval authorizes only the displayed invoice revision and expires', async t => {
  for (const invalidation of ['revision', 'expiry', 'withdrawal']) {
    await t.test(invalidation, async local => {
      const household = await startHousehold(local);
      const bill = errand(await household.checkpoint(), 'bill');
      const approved = await household.billChoice(bill, 'approve');
      assert.equal(approved.approval.amountMinor, requestedAmount);
      assert.equal(approved.approval.revision, bill.invoice.revision);
      if (invalidation === 'revision') {
        household.provider(openBillFixture).putInvoice({ ...mondayBill, revision: 3, amountMinor: 126000 });
      } else if (invalidation === 'expiry') {
        household.moveTime(approved.approval.expiresAt);
      } else {
        await household.access(approved, 'payment', 'withdrawn');
      }
      const latest = errand(await household.checkpoint(), 'bill');
      assert.equal(latest.status, 'open');
      assert.equal(latest.approval, null);
      assert.equal(latest.grants.payment.scope.capMinor, billCap);
      assert.deepEqual((await household.native('bill')).payments, []);
      assert.deepEqual((await household.native('bill')).attempts, []);
      assert.ok(!(await household.inspect()).actions.some(action => action.operation === 'pay'));
      if (invalidation === 'revision') {
        assert.equal(latest.invoice.revision, 3);
        assert.equal(latest.invoice.amountMinor, 126000);
        assert.equal(latest.issue, 'bill-review');
      }
    });
  }
});

test('an old review with a grant for another invoice cannot read or grant a bill exception', async t => {
  const household = await startHousehold(t);
  const bill = errand(await household.checkpoint(), 'bill');
  const before = await household.native('bill');
  const { invoice } = bill.grants;
  household.persistLegacyErrand({ ...bill, grants: { ...bill.grants, invoice: {
    ...invoice, scope: { ...invoice.scope, invoiceId: 'another-synthetic-invoice' }
  } } });
  for (const choice of ['defer', 'approve']) await household.billChoice(bill, choice, 409);
  assert.deepEqual(await household.native('bill'), before);
  const after = errand(await household.desk(), 'bill');
  assert.equal(after.approval, null);
  assert.equal(after.deferred, null);
  assert.equal(after.revision, bill.revision);
});

test('bill approval requires the active payment grant to match the displayed exception', async t => {
  const household = await startHousehold(t);
  const bill = errand(await household.checkpoint(), 'bill');
  const { payment } = bill.grants;
  const before = await household.native('bill');
  for (const grant of [
    { ...payment, operation: 'invoice' },
    { ...payment, scope: { ...payment.scope, payee: 'another-practice-payee' } },
    { ...payment, scope: { ...payment.scope, currency: 'USD' } },
    { ...payment, scope: { ...payment.scope, capMinor: billCap - 1 } }
  ]) {
    household.persistLegacyErrand({ ...bill, grants: { ...bill.grants, payment: grant } });
    await household.billChoice(bill, 'approve', 409);
    const rejected = errand(await household.desk(), 'bill');
    assert.equal(rejected.approval, null);
    assert.equal(rejected.revision, bill.revision);
    assert.deepEqual(await household.native('bill'), before);
  }

  const withdrawn = await household.access(bill, 'payment', 'withdrawn');
  const deferred = await household.billChoice(withdrawn, 'defer');
  assert.deepEqual(deferred.deferred, bill.invoice);
  const after = await household.native('bill');
  assert.equal(after.reads.length, before.reads.length + 1);
  assert.deepEqual(after.payments, []);
  assert.deepEqual(after.attempts, []);
});

test('repeating a bill approval cannot extend its expiry or authorize a changed invoice', async t => {
  const household = await startHousehold(t);
  const bill = errand(await household.checkpoint(), 'bill');
  const provider = household.provider(openBillFixture);
  const revised = { ...mondayBill, revision: 3, amountMinor: 126000 };
  provider.putInvoice(revised);
  await household.billChoice(bill, 'approve', 409);
  assert.equal(errand(await household.desk(), 'bill').approval, null);

  const latest = errand(await household.checkpoint(), 'bill');
  const approved = await household.billChoice(latest, 'approve');
  const before = await household.native('bill');
  household.moveTime('2026-11-23T03:35:00.000Z');
  await household.billChoice(approved, 'approve', 409);
  const stillApproved = errand(await household.desk(), 'bill');
  assert.deepEqual(stillApproved.approval, approved.approval);
  assert.equal(stillApproved.revision, approved.revision);
  assert.deepEqual(await household.native('bill'), before);

  household.moveTime(approved.approval.expiresAt);
  const renewed = await household.billChoice(stillApproved, 'approve');
  assert.equal(renewed.approval.revision, revised.revision);
  assert.ok(Date.parse(renewed.approval.expiresAt) > Date.parse(approved.approval.expiresAt));
});

test('payment access must still be active after the authorized invoice read', async t => {
  const household = await startHousehold(t);
  const bill = errand(await household.checkpoint(), 'bill');
  household.moveTime(tuesday);
  const ready = await household.access(bill, 'invoice', 'allowed');
  const before = await household.native('bill');
  const expiry = ready.grants.payment.expiresAt;
  const beforeExpiry = new Date(Date.parse(expiry) - 1).toISOString();
  let reads = 0;
  household.moveTime(() => reads++ < 2 ? beforeExpiry : expiry);

  await household.billChoice(ready, 'approve', 409);
  const after = await household.native('bill');
  assert.deepEqual(after.reads.slice(before.reads.length), [{
    source: 'invoice', scope: { invoiceId: bill.invoice.invoiceId }, checkedAt: beforeExpiry
  }]);
  assert.deepEqual(after.payments, []);
  assert.deepEqual(after.attempts, []);
  const stillOpen = errand(await household.desk(), 'bill');
  assert.equal(stillOpen.revision, ready.revision);
  assert.equal(stillOpen.approval, null);
});

test('the operator can publish a new bill without carrying forward approval or changing a past revision', async t => {
  const household = await startHousehold(t);
  const original = errand(await household.checkpoint(), 'bill');
  await household.billChoice(original, 'approve');
  const revision = ['bill-revision', '3', '125000', 'INR', 'city-electric'];
  const revised = household.operator(revision);
  assert.deepEqual(revised, { ...mondayBill, revision: 3, amountMinor: 125000 });
  assert.deepEqual(household.operator(revision), revised);
  assert.match(household.operator(['bill-revision', '3', '125001', 'INR', 'city-electric'], 1), /above the latest/);
  assert.match(household.operator(['bill-revision', '4', '12.50', 'INR', 'city-electric'], 1), /minor-unit/);
  const updated = errand(await household.checkpoint(), 'bill');
  assert.equal(updated.approval, null);
  assert.equal(updated.issue, 'bill-review');
  assert.deepEqual(updated.invoice, revised);
  assert.equal(updated.grants.payment.scope.capMinor, billCap);
  await household.billChoice(updated, 'approve');
  household.operator(['bill-revision', '4', '125000', 'INR', 'another-practice-payee']);
  const changed = errand(await household.checkpoint(), 'bill');
  assert.equal(changed.invoice.payeeLabel, original.invoice.payeeLabel);
  assert.equal(changed.issue, 'bill-permission');
  const native = await household.native('bill');
  assert.equal(native.invoices.length, 4);
  assert.deepEqual(native.payments, []);
  assert.deepEqual(native.attempts, []);
});

test('a lost booking reply set by the operator recovers one native reservation and calendar entry', async t => {
  const household = await startHousehold(t);
  assert.deepEqual(household.operator(['lose-next-reply', 'reservation']), { operation: 'reservation', nextReply: 'will-be-lost' });
  const unknown = errand(await household.checkpoint(), 'visit');
  assert.equal(unknown.issue, 'reservation-unknown');
  assert.equal(unknown.reservation, null);
  await household.restart();
  const recovered = errand(await household.checkpoint(), 'visit');
  assert.equal(recovered.status, 'verified');
  const native = await household.native('visit');
  assert.deepEqual(native.reservations, [recovered.reservation]);
  assert.equal(native.attempts.filter(row => row.operation === 'reserve').length, 1);
  assert.equal(native.calendar.filter(row => row.reservationId === recovered.reservation.id).length, 1);
});

test('a lost payment reply reconciles one exact committed payment across restart and waits for settlement', async t => {
  const household = await startHousehold(t);
  const provider = household.provider(openBillFixture);
  const bill = errand(await household.checkpoint(), 'bill');
  const approved = await household.billChoice(bill, 'approve');
  await household.billChoice(bill, 'approve', 409);
  household.operator(['lose-next-reply', 'payment']);
  const unknown = errand(await household.checkpoint(), 'bill');
  assert.equal(unknown.issue, 'payment-unknown');
  const first = await household.native('bill');
  assert.equal(first.payments.length, 1);
  assert.equal(first.attempts.length, 1);
  assert.equal(first.attempts[0].status, 'reply-lost');
  const [payment] = first.payments;
  assert.equal(payment.invoiceId, approved.approval.invoiceId);
  assert.equal(payment.revision, approved.approval.revision);
  assert.equal(payment.payee, approved.approval.payee);
  assert.equal(payment.amountMinor, approved.approval.amountMinor);
  assert.equal(payment.currency, approved.approval.currency);
  const pendingIntent = (await household.inspect()).actions.find(action => action.operation === 'pay');
  assert.equal(pendingIntent.key, payment.key);
  assert.equal(pendingIntent.status, 'unknown');

  await household.access(unknown, 'payment', 'withdrawn');
  await household.restart(tuesday);
  const recovered = errand(await household.checkpoint(), 'bill');
  assert.equal(recovered.status, 'accepted');
  assert.equal(recovered.issue, 'payment-pending');
  assert.equal(recovered.approval.status, 'consumed');
  assert.deepEqual(recovered.payment, payment);
  assert.equal(recovered.grants.payment.scope.capMinor, billCap);
  assert.equal(recovered.grants.payment.status, 'withdrawn');
  const receipt = {
    paymentRef: payment.paymentRef,
    invoiceId: payment.invoiceId,
    revision: payment.revision,
    payee: payment.payee,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    status: 'settled',
    settledAt: tuesday
  };
  provider.putSettlement({ ...receipt, payee: 'payee-demo-wrong' });
  assert.equal(errand(await household.checkpoint(), 'bill').status, 'accepted');
  provider.putSettlement(receipt);
  const settled = errand(await household.checkpoint(), 'bill');
  assert.equal(settled.status, 'verified');
  assert.deepEqual(settled.settlement, receipt);
  const final = await household.native('bill');
  assert.deepEqual(final.payments, [payment]);
  assert.deepEqual(final.attempts, first.attempts);
  assert.equal((await household.inspect()).actions.find(action => action.key === payment.key).status, 'committed');
});

test('a lost calendar reply is reconciled against the original entry only after read access returns', async t => {
  const household = await startHousehold(t);
  household.operator(['lose-next-reply', 'calendar']);
  const pending = errand(await household.checkpoint(), 'visit');
  assert.equal(pending.status, 'booked');
  assert.equal(pending.issue, 'calendar-unknown');
  assert.equal(pending.calendarEvent, null);
  const original = await household.native('visit');
  const events = original.calendar.filter(event => event.reservationId === pending.reservation.id);
  assert.equal(events.length, 1);
  assert.deepEqual(original.attempts.map(({ status }) => status), ['confirmed', 'unknown']);
  assert.equal((await household.inspect()).actions.find(action => action.operation === 'calendar').status, 'unknown');
  await household.access(pending, 'calendar', 'withdrawn');
  await household.restart();
  const held = errand(await household.checkpoint(), 'visit');
  assert.equal(held.issue, 'calendar-unknown');
  assert.equal(held.calendarEvent, null);
  assert.deepEqual((await household.native('visit')).reads, original.reads);
  await household.access(held, 'calendar', 'allowed');
  const recovered = errand(await household.checkpoint(), 'visit');
  assert.equal(recovered.status, 'verified');
  assert.equal(recovered.reservation.id, pending.reservation.id);
  assert.equal(recovered.calendarEvent.id, events[0].id);
  const final = await household.native('visit');
  assert.deepEqual(final.reservations, original.reservations);
  assert.deepEqual(final.calendar, original.calendar);
  assert.deepEqual(final.attempts, original.attempts);
});

test('a protected event arriving after booking preserves the original reservation and reports a calendar conflict', async t => {
  const household = await startHousehold(t);
  const provider = household.provider(openVisitFixture);
  assert.deepEqual(household.operator(['fail-next-calendar-write']), { operation: 'calendar', nextWrite: 'will-fail' });
  const booked = errand(await household.checkpoint(), 'visit');
  assert.equal(booked.status, 'booked');
  assert.equal(booked.issue, 'calendar-pending');
  assert.equal(booked.calendarEvent, null);
  const initial = await household.native('visit');
  assert.deepEqual(initial.reservations, [booked.reservation]);
  assert.equal(initial.calendar.length, 1);
  const inserted = provider.putCalendarEvent({
    id: 'calendar-demo-arrived-after-reservation', start: visitStart, end: visitEnd,
    title: 'Synthetic newly protected calendar title'
  });

  await household.restart(tuesday);
  const brief = await household.checkpoint();
  const conflict = errand(brief, 'visit');
  assert.equal(conflict.status, 'booked');
  assert.equal(conflict.issue, 'calendar-conflict');
  assert.deepEqual(conflict.reservation, booked.reservation);
  assert.deepEqual(conflict.conflict, { start: inserted.start, end: inserted.end });
  assert.equal(conflict.calendarEvent, null);
  const repeat = errand(await household.checkpoint(), 'visit');
  assert.deepEqual(repeat, conflict);
  const native = await household.native('visit');
  assert.deepEqual(native.reservations, initial.reservations);
  assert.deepEqual(native.calendar, [...initial.calendar, inserted]);
  assert.equal(native.attempts.filter(item => item.operation === 'reserve').length, 1);
  assert.equal(native.attempts.filter(item => item.operation === 'calendar.add').length, 2);
  assert.ok(!JSON.stringify({ brief, inspection: await household.inspect() }).includes(inserted.title));
});

test('visit conflict choices require current native evidence and never alter the booking or protected event', async t => {
  const household = await startHousehold(t);
  const provider = household.provider(openVisitFixture);
  provider.failNextCalendarWrite();
  const booked = errand(await household.checkpoint(), 'visit');
  const overlap = {
    id: 'calendar-demo-user-conflict', start: visitStart, end: visitEnd,
    title: 'Synthetic protected appointment'
  };
  provider.putCalendarEvent(overlap);
  const review = errand(await household.checkpoint(), 'visit');
  const before = await household.native('visit');
  const chosen = await household.visitChoice(review, 'handle');
  const binding = { reservationId: booked.reservation.id, start: visitStart, end: visitEnd };
  assert.equal(chosen.issue, 'calendar-conflict');
  assert.equal(chosen.status, 'booked');
  assert.deepEqual(chosen.conflictChoice, { choice: 'handle', ...binding });
  const after = await household.native('visit');
  assert.deepEqual(after.reads.slice(before.reads.length).map(({ source, scope }) => ({ source, scope })), [
    { source: 'reservation', scope: { key: booked.reservation.key } },
    { source: 'calendarConflict', scope: { reservationId: booked.reservation.id } }
  ]);
  assert.deepEqual(after.attempts, before.attempts);
  assert.deepEqual(after.calendar, before.calendar);
  await household.visitChoice(review, 'watch', 409);
  assert.deepEqual(await household.native('visit'), after);

  await household.restart(tuesday);
  assert.deepEqual(errand(await household.checkpoint(), 'visit'), chosen);
  provider.putCalendarEvent({ ...overlap, start: visitEnd, end: mondayVisit.windowEnd });
  const handled = errand(await household.checkpoint(), 'visit');
  assert.equal(handled.status, 'booked');
  assert.equal(handled.issue, 'calendar-pending');
  assert.deepEqual(handled.conflictChoice, chosen.conflictChoice);
  assert.deepEqual((await household.native('visit')).attempts, before.attempts);

  provider.putCalendarEvent(overlap);
  const reopened = errand(await household.checkpoint(), 'visit');
  assert.equal(reopened.issue, 'calendar-conflict');
  assert.equal(reopened.conflictChoice, null);
  const narrowed = provider.putCalendarEvent({
    ...overlap, start: '2026-11-24T15:15:00+05:30', end: '2026-11-24T15:45:00+05:30'
  });
  await household.visitChoice(reopened, 'watch', 409);
  const changed = errand(await household.checkpoint(), 'visit');
  assert.deepEqual(changed.conflict, { start: narrowed.start, end: narrowed.end });
  assert.equal(changed.conflictChoice, null);

  const denied = await household.access(changed, 'freeBusy', 'withdrawn');
  const beforeDenial = await household.native('visit');
  await household.visitChoice(denied, 'watch', 409);
  assert.deepEqual(await household.native('visit'), beforeDenial);
  const allowed = await household.access(denied, 'freeBusy', 'allowed');
  const watched = await household.visitChoice(allowed, 'watch');
  assert.equal(watched.status, 'booked');
  assert.deepEqual(watched.conflictChoice, {
    choice: 'watch', reservationId: binding.reservationId, start: narrowed.start, end: narrowed.end
  });
  assert.deepEqual((await household.native('visit')).attempts, before.attempts);

  const clear = provider.putCalendarEvent({ ...overlap, start: visitEnd, end: mondayVisit.windowEnd });
  const verified = errand(await household.checkpoint(), 'visit');
  assert.equal(verified.status, 'verified');
  assert.equal(verified.conflictChoice, null);
  assert.deepEqual(verified.reservation, booked.reservation);
  assert.equal(verified.calendarEvent.reservationId, booked.reservation.id);
  const final = await household.native('visit');
  assert.deepEqual(final.reservations, before.reservations);
  assert.deepEqual(final.calendar.find(event => event.id === overlap.id), clear);
  assert.deepEqual(final.attempts.slice(before.attempts.length).map(({ operation, status }) => ({ operation, status })), [
    { operation: 'calendar.add', status: 'recorded' }
  ]);
  assert.deepEqual(final.reads.slice(-2).map(read => read.source), ['calendar', 'calendarConflict']);
});

test('stopping an open errand withdraws its permissions and leaves its evidence unresolved', async t => {
  const household = await startHousehold(t);
  const refund = errand(await household.checkpoint(), 'refund');
  const reads = (await household.native('refund')).reads;
  const stopped = await household.tracking(refund, 'stop');
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(stopped.evidence, []);
  assert.equal(stopped.note, refund.note);
  assert.equal(stopped.checkDate, refund.checkDate);
  assert.equal(stopped.refundAccess.credits.status, 'withdrawn');
  await household.refundAccess(stopped, 'merchant', 'allowed', 409);
  await household.refundAccess(stopped, 'credits', 'allowed', 409);
  assert.deepEqual(errand(await household.checkpoint(), 'refund'), stopped);
  const withdrawn = await household.refundAccess(stopped, 'credits', 'withdrawn');
  await household.restart();
  const resumed = await household.tracking(withdrawn, 'resume');
  assert.equal(resumed.status, 'open');
  assert.equal(resumed.refundAccess.merchant.status, 'withdrawn');
  assert.equal(resumed.refundAccess.credits.status, 'withdrawn');
  assert.deepEqual(errand(await household.checkpoint(), 'refund'), resumed);
  assert.deepEqual((await household.native('refund')).reads, reads);
});

test('a stopped bill can withdraw access but cannot allow access or make a bill choice', async t => {
  const household = await startHousehold(t);
  const bill = errand(await household.checkpoint(), 'bill');
  const approved = await household.billChoice(bill, 'approve');
  const stopped = await household.tracking(approved, 'stop');
  const native = await household.native('bill');
  assert.equal(stopped.approval, null);
  await household.access(stopped, 'invoice', 'allowed', 409);
  await household.access(stopped, 'payment', 'allowed', 409);
  await household.billChoice(stopped, 'approve', 409);
  await household.billChoice(stopped, 'defer', 409);
  assert.deepEqual(errand(await household.checkpoint(), 'bill'), stopped);
  const withdrawn = await household.access(stopped, 'payment', 'withdrawn');
  await household.restart();
  const resumed = await household.tracking(withdrawn, 'resume');
  assert.equal(resumed.grants.invoice.status, 'withdrawn');
  assert.equal(resumed.grants.payment.status, 'withdrawn');
  assert.equal(errand(await household.checkpoint(), 'bill').issue, 'bill-permission');
  assert.deepEqual(await household.native('bill'), native);
});

test('resuming a legacy stopped case withdraws access granted by an earlier build', async t => {
  const household = await startHousehold(t);
  const brief = await household.checkpoint();
  const approved = await household.billChoice(errand(brief, 'bill'), 'approve');
  const refund = errand(brief, 'refund');
  const stoppedBill = await household.tracking(approved, 'stop');
  const stoppedRefund = await household.tracking(refund, 'stop');
  household.persistLegacyErrand({ ...stoppedBill, grants: approved.grants, approval: approved.approval });
  household.persistLegacyErrand({ ...stoppedRefund, refundAccess: refund.refundAccess });
  const beforeBill = await household.native('bill');
  const beforeRefund = await household.native('refund');

  await household.restart();
  const persisted = await household.desk();
  const resumedBill = await household.tracking(errand(persisted, 'bill'), 'resume');
  const resumedRefund = await household.tracking(errand(persisted, 'refund'), 'resume');
  assert.equal(resumedBill.approval, null);
  assert.ok(Object.values(resumedBill.grants).every(grant => grant.status === 'withdrawn'));
  assert.ok(Object.values(resumedRefund.refundAccess).every(grant => grant.status === 'withdrawn'));
  await household.checkpoint();
  assert.deepEqual(await household.native('bill'), beforeBill);
  assert.deepEqual(await household.native('refund'), beforeRefund);
});

test('the review queues one exact local follow-up and a matching credit retires an unsent draft', async t => {
  await t.test('queue first', async t => {
    const household = await startHousehold(t);
    const refund = errand(await household.checkpoint(), 'refund');
    const draft = await household.draft(refund);
    assert.deepEqual((await household.native('outbox')).messages, []);
    const approved = { ...draft, text: `${draft.text}\n\nPlease reply with a reference. ` };
    const queued = await household.queue(refund, approved);
    assert.equal(queued.status, 'open');
    assert.equal(queued.queuedFollowup.text, approved.text);
    assert.equal(queued.queuedFollowup.recipient, approved.recipient);
    assert.equal(queued.queuedFollowup.subject, approved.subject);
    await household.restart(tuesday);
    assert.deepEqual((await household.queue(refund, approved)).queuedFollowup, queued.queuedFollowup);
    assert.deepEqual((await household.native('outbox')).messages, [queued.queuedFollowup]);
  });
  await t.test('credit first', async t => {
    const household = await startHousehold(t);
    const refund = errand(await household.checkpoint(), 'refund');
    const draft = await household.draft(refund);
    const fixture = household.provider(openRefundFixture);
    fixture.putCredit({
      id: 'credit-demo-before-approval',
      account: mondayRefund.account,
      amountMinor: mondayRefund.amountMinor,
      currency: mondayRefund.currency,
      direction: 'incoming',
      status: 'posted',
      returnReference: mondayRefund.reference,
      postedAt: monday
    });
    const result = await household.queue(refund, draft);
    assert.equal(result.status, 'verified');
    assert.equal(result.queuedFollowup, undefined);
    assert.deepEqual((await household.native('outbox')).messages, []);
  });
});

test('a practice reset clears the refund follow-up journal as well as the native outbox', async t => {
  const household = await startHousehold(t);
  const original = errand(await household.desk(), 'refund');
  const draft = await household.draft(original);
  const queued = await household.queue(original, draft);
  assert.equal(queued.queuedFollowup.text, draft.text);

  await household.restart(monday, true);
  const reset = errand(await household.desk(), 'refund');
  assert.deepEqual((await household.native('outbox')).messages, []);
  assert.ok(!(await household.inspect()).actions.some(action => action.errandId === reset.id));
  const newDraft = { ...draft, text: 'Please confirm the refund reference.' };
  const updated = await household.queue(reset, newDraft);
  assert.equal(updated.queuedFollowup.text, newDraft.text);
  assert.deepEqual((await household.native('outbox')).messages, [updated.queuedFollowup]);
});

test('an ambiguous outbox reply remains unknown across restart until the exact original is recovered', async t => {
  const household = await startHousehold(t);
  const fixture = household.provider(openOutboxFixture);
  const refund = errand(await household.desk(), 'refund');
  const draft = { ...await household.draft(refund), text: 'May I have the transfer reference, please?' };
  household.operator(['lose-next-reply', 'outbox']);
  fixture.failNextReadback();

  const uncertain = await household.queue(refund, draft, 409);
  assert.match(uncertain.error, /original draft/i);
  const waiting = errand(await household.desk(), 'refund');
  assert.equal(waiting.queuedFollowup, undefined);
  assert.equal(waiting.pendingFollowup, true);
  assert.equal((await household.inspect()).actions.find(action => action.operation === 'followup').status, 'unknown');
  const committed = await household.native('outbox');
  assert.equal(committed.messages.length, 1);
  assert.equal(committed.attempts.length, 1);
  assert.equal(committed.attempts[0].code, 'reply-lost');

  await household.restart(tuesday);
  const stopped = await household.tracking(errand(await household.desk(), 'refund'), 'stop');
  const beforeRecovery = await household.native('refund');
  assert.equal(errand(await household.desk(), 'refund').pendingFollowup, true);
  const restoredDraft = await household.draft(stopped);
  assert.deepEqual(restoredDraft, { ...draft, pendingFollowup: true });
  assert.deepEqual(await household.native('outbox'), committed);
  assert.deepEqual(await household.native('refund'), beforeRecovery);
  await household.queue(stopped, { ...restoredDraft, text: draft.text + ' ', reconcileOnly: true }, 409);
  const recovered = await household.queue(refund, { ...restoredDraft, reconcileOnly: true });
  assert.equal(recovered.status, stopped.status);
  assert.deepEqual(recovered.queuedFollowup, committed.messages[0]);
  assert.equal(errand(await household.desk(), 'refund').pendingFollowup, undefined);
  assert.deepEqual(await household.native('refund'), beforeRecovery);
  await household.queue(recovered, { ...draft, text: draft.text + ' ' }, 409);
  assert.deepEqual(await household.native('outbox'), committed);
  assert.equal((await household.inspect()).actions.find(action => action.operation === 'followup').status, 'committed');
});

test('outbox readback with the same key and different text cannot present a draft as queued', async t => {
  const household = await startHousehold(t);
  const fixture = household.provider(openOutboxFixture);
  const refund = errand(await household.desk(), 'refund');
  const { recipient, subject, text } = await household.draft(refund);
  const draft = { recipient, subject, text };
  const key = 'followup-' + createHash('sha256').update(JSON.stringify([refund.id, draft])).digest('hex');
  const seeded = fixture.enqueue({ ...draft, key, text: 'Synthetic conflicting native text.' }, () => true);

  await household.queue(refund, draft, 409);
  await household.restart(tuesday);
  await household.queue(refund, draft, 409);
  assert.equal(errand(await household.desk(), 'refund').queuedFollowup, undefined);
  assert.deepEqual((await household.native('outbox')).messages, [seeded]);
  assert.equal((await household.inspect()).actions.find(action => action.operation === 'followup').status, 'unknown');
});

test('a fresh credit outage holds a follow-up but a withdrawn read cannot reuse the stale outage', async t => {
  const household = await startHousehold(t);
  household.provider(openRefundFixture).setAvailable('credits', false);
  const refund = errand(await household.desk(), 'refund');
  const draft = await household.draft(refund);
  const held = await household.queue(refund, draft);
  assert.equal(held.checks.credits.status, 'unavailable');
  assert.equal(held.queuedFollowup, undefined);
  assert.deepEqual((await household.native('outbox')).attempts, []);

  const withdrawn = await household.refundAccess(held, 'credits', 'withdrawn');
  const before = await household.native('refund');
  const queued = await household.queue(withdrawn, draft);
  assert.equal(queued.queuedFollowup.text, draft.text);
  assert.deepEqual((await household.native('refund')).reads.slice(before.reads.length).map(({ source }) => source), ['merchant']);
  assert.deepEqual((await household.native('outbox')).messages, [queued.queuedFollowup]);
});
