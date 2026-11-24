import assert from 'node:assert/strict';
import test from 'node:test';
import { billDecision, orderChecks, reviewNeeded, visitConflictDecision } from '../shared/brief-order.mjs';
import { seedHousehold } from '../src/household.mjs';

const now = '2026-11-23T03:30:00.000Z';
const expiry = '2026-11-23T03:45:00.000Z';
const earlier = { id: 'earlier', status: 'open', checkDate: '2026-11-21' };
const firstInBrief = (record, at = now) => orderChecks([earlier, record], true, at)[0].id;

test('only a current bill exception takes priority in the brief', () => {
  const seeded = seedHousehold(new Date(now), true).find(record => record.kind === 'bill');
  const invoice = { ...seeded.invoice, revision: 2, amountMinor: 118000 };
  const bill = { ...seeded, invoice, issue: 'bill-review' };
  assert.equal(firstInBrief(bill), bill.id);
  const approval = { ...invoice, grantRevision: bill.grants.payment.revision, status: 'allowed', expiresAt: expiry };
  const pending = { ...bill, approval };
  assert.equal(firstInBrief(pending), earlier.id);
  assert.equal(billDecision(pending, now).approved, true);
  assert.equal(firstInBrief(pending, expiry), bill.id);

  const withGrant = (operation, update) => ({ ...bill, grants: {
    ...bill.grants,
    [operation]: { ...bill.grants[operation], ...update }
  } });
  for (const held of [
    withGrant('payment', { status: 'withdrawn' }),
    withGrant('payment', { expiresAt: now }),
    withGrant('payment', { scope: { ...bill.grants.payment.scope, capMinor: 1 } }),
    { ...bill, invoice: seeded.invoice }
  ]) {
    assert.equal(firstInBrief(held), earlier.id);
    assert.equal(billDecision(held, now).canDefer, true);
    assert.equal(billDecision(held, now).canApprove, false);
  }
  for (const paused of [
    withGrant('invoice', { status: 'withdrawn' }),
    withGrant('invoice', { expiresAt: now }),
    withGrant('invoice', { scope: { ...bill.bill, invoiceId: 'other' } }),
    { ...bill, grants: {} }
  ]) {
    assert.equal(firstInBrief(paused), earlier.id);
    assert.equal(billDecision(paused, now).canDefer, false);
  }
});

test('a booked conflict needs review only with both exact read scopes and an unhandled overlap', () => {
  const seeded = seedHousehold(new Date(now), true).find(record => record.kind === 'visit');
  const reservation = { id: 'reservation-example', status: 'confirmed', start: '2026-11-24T15:00:00+05:30', end: '2026-11-24T16:00:00+05:30' };
  const conflict = { start: '2026-11-24T15:10:00+05:30', end: '2026-11-24T15:30:00+05:30' };
  const grants = { slots: seeded.grants.slots, freeBusy: seeded.grants.freeBusy };
  const visit = { ...seeded, reservation, conflict, grants, status: 'booked', issue: 'calendar-conflict' };
  assert.equal(firstInBrief(visit), visit.id);
  const watched = { ...visit, conflictChoice: { choice: 'watch', reservationId: reservation.id, ...conflict } };
  assert.equal(firstInBrief(watched), earlier.id);
  assert.equal(visitConflictDecision(watched, now).canChoose, true);
  assert.equal(reviewNeeded({ ...watched, conflict: { ...conflict, end: reservation.end } }, now), true);
  assert.equal(reviewNeeded({ ...visit, conflict: { ...conflict, end: conflict.start } }, now), false);

  for (const operation of ['slots', 'freeBusy']) {
    for (const update of [{ status: 'withdrawn' }, { expiresAt: now }, { scope: { ...visit.visit, issuer: 'other' } }]) {
      const paused = { ...visit, grants: { ...grants, [operation]: { ...grants[operation], ...update } } };
      assert.equal(firstInBrief(paused), earlier.id);
      assert.equal(visitConflictDecision(paused, now).canChoose, false);
      assert.equal(paused.reservation, reservation);
    }
  }
});
