import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mondayVisit, openVisitFixture } from '../src/visit-fixture.mjs';

const { issuer, service, subject } = mondayVisit;
const slotScope = { issuer, service, subject };
const allowed = () => true;
const clock = () => new Date('2026-11-23T03:30:00.000Z');
const reserveRequest = slot => ({ ...mondayVisit, key: 'reserve-one-visit', slotId: slot.id, revision: slot.revision });
const calendarRequest = reservation => ({ key: 'record-one-visit', reservationId: reservation.id });

function setup(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-visit-'));
  let fixture = openVisitFixture({ dataDir, clock });
  fixture.reset();
  t.after(() => {
    fixture.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    fixture,
    reopen() {
      fixture.close();
      fixture = openVisitFixture({ dataDir, clock });
      return fixture;
    }
  };
}

test('booking rechecks exact slot, zero fee, visit window and current free/busy', t => {
  const { fixture } = setup(t);
  const [morning, afternoon] = fixture.readSlots(slotScope);
  const protectedEvent = fixture.inspect().calendar[0];
  assert.deepEqual(fixture.readSlots({ ...slotScope, subject: 'different-subject' }), []);
  assert.deepEqual(fixture.readFreeBusy({ start: morning.start, end: afternoon.end }), [
    { start: protectedEvent.start, end: protectedEvent.end }
  ]);
  assert.deepEqual(fixture.readFreeBusy(afternoon), []);
  assert.ok(!JSON.stringify(fixture.inspect().reads).includes(protectedEvent.title));
  assert.equal(fixture.reserve(reserveRequest(morning), allowed).reason, 'outside-window');
  assert.equal(fixture.reserve(reserveRequest(afternoon)).reason, 'permission');

  const paid = fixture.putSlot({ ...afternoon, feeMinor: 12000, revision: 2 });
  assert.equal(fixture.reserve(reserveRequest(afternoon), allowed).reason, 'slot-revised');
  assert.equal(fixture.reserve(reserveRequest(paid), allowed).reason, 'slot-fee');
  const withdrawn = fixture.putSlot({ ...afternoon, active: false, revision: 3 });
  assert.equal(fixture.reserve(reserveRequest(withdrawn), allowed).reason, 'slot-unavailable');
  const available = fixture.putSlot({ ...afternoon, revision: 4 });
  fixture.putCalendarEvent({ id: 'calendar-demo-new-conflict', start: afternoon.start, end: afternoon.end, title: 'Private' });
  assert.equal(fixture.reserve(reserveRequest(available), allowed).reason, 'calendar-conflict');
  assert.deepEqual(fixture.inspect().reservations, []);
  assert.deepEqual(fixture.inspect().calendar[0], protectedEvent);
});

test('a lost booking reply and failed calendar write recover the original receipt once', t => {
  const setupResult = setup(t);
  let fixture = setupResult.fixture;
  const [, slot] = fixture.readSlots(slotScope);
  const request = reserveRequest(slot);
  fixture.failNextReservationReply();
  assert.deepEqual(fixture.reserve(request, allowed), { status: 'unknown', reason: 'reply-lost' });
  fixture = setupResult.reopen();
  const reservation = fixture.reservationByKey(request.key);
  assert.equal(reservation.status, 'confirmed');
  assert.equal(reservation.slotId, slot.id);
  assert.deepEqual(fixture.reserve(request, () => false), { status: 'confirmed', reservation });
  assert.equal(fixture.reserve({ ...request, revision: 2 }, allowed).reason, 'key-conflict');

  const calendar = calendarRequest(reservation);
  fixture.failNextCalendarWrite();
  assert.deepEqual(fixture.addToCalendar(calendar, allowed), { status: 'failed', reason: 'calendar-unavailable' });
  assert.equal(fixture.calendarByReservation(reservation.id), null);
  fixture = setupResult.reopen();
  const written = fixture.addToCalendar(calendar, allowed);
  assert.equal(written.status, 'recorded');
  assert.deepEqual(fixture.addToCalendar(calendar, () => false), written);
  assert.deepEqual(fixture.calendarByReservation(reservation.id), written.event);
  assert.deepEqual(fixture.inspect().reservations, [reservation]);
  assert.equal(fixture.inspect().calendar.length, 2);
});

test('a protected calendar event added after booking survives every sync attempt', t => {
  const setupResult = setup(t);
  let fixture = setupResult.fixture;
  const [, slot] = fixture.readSlots(slotScope);
  const { reservation } = fixture.reserve(reserveRequest(slot), allowed);
  const conflict = fixture.putCalendarEvent({
    id: 'calendar-demo-after-booking',
    start: slot.start,
    end: slot.end,
    title: 'Private conflict'
  });
  const expected = { status: 'conflict', interval: { start: slot.start, end: slot.end } };
  const calendar = calendarRequest(reservation);
  assert.deepEqual(fixture.addToCalendar(calendar, allowed), expected);
  fixture = setupResult.reopen();
  assert.deepEqual(fixture.addToCalendar(calendar, allowed), expected);
  assert.deepEqual(fixture.calendarConflictForReservation(reservation.id), expected.interval);
  assert.equal(fixture.calendarByReservation(reservation.id), null);
  assert.deepEqual(fixture.inspect().reservations, [reservation]);
  assert.deepEqual(fixture.inspect().calendar.find(event => event.id === conflict.id), conflict);
});
