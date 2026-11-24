import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { mondayBill, openBillFixture } from '../src/bill-fixture.mjs';
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
  const clock = () => new Date(time);

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
    async restart(nextTime = time, reset = false) {
      time = nextTime;
      await open(reset);
    },
    moveTime(next) { time = next; },
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
    queue: (errand, terms) => request(`/api/errands/${errand.id}/queue-followup`, { revision: errand.revision, ...terms }),
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

test('a lost payment reply reconciles one exact committed payment across restart and waits for settlement', async t => {
  const household = await startHousehold(t);
  const provider = household.provider(openBillFixture);
  const bill = errand(await household.checkpoint(), 'bill');
  const approved = await household.billChoice(bill, 'approve');
  await household.billChoice(bill, 'approve', 409);
  provider.failNextReply();
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

test('a protected event arriving after booking preserves the original reservation and reports a calendar conflict', async t => {
  const household = await startHousehold(t);
  const provider = household.provider(openVisitFixture);
  provider.failNextCalendarWrite();
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
  assert.equal(final.reads.at(-1).source, 'calendar');
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
