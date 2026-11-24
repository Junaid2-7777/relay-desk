import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openActionJournal } from '../src/action-journal.mjs';
import { makeGrant, seedHousehold } from '../src/household.mjs';
import { mondayVisit, openVisitFixture } from '../src/visit-fixture.mjs';
import { runVisit } from '../src/visit.mjs';

function openVisitJournal(dataDir, find, clock) {
  const database = new DatabaseSync(join(dataDir, 'desk.sqlite'));
  const transaction = callback => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
  return { journal: openActionJournal(database, find, transaction, clock), close: () => database.close() };
}

test('reopening after an interrupted retry recovers the original visit before reserving another slot', t => {
  const now = new Date('2026-11-23T09:00:00+05:30');
  const clock = () => now;
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-visit-retry-'));
  const fixture = openVisitFixture({ dataDir, clock });
  let visit = seedHousehold(now, true).find(record => record.kind === 'visit');
  t.after(() => {
    fixture.close();
    rmSync(dataDir, { force: true, recursive: true });
  });

  function withJournal(action) {
    const connection = openVisitJournal(dataDir, () => visit, clock);
    try {
      action(connection.journal);
    } finally {
      connection.close();
    }
  }

  fixture.reset();
  withJournal(journal => {
    const blocked = { ...fixture, reserve: () => ({ status: 'blocked', reason: 'calendar-conflict' }) };
    visit = runVisit(visit, blocked, journal, now);
    const original = journal.latest(visit.id, 'reserve');
    assert.equal(original.status, 'blocked');
    assert.throws(() => journal.prepare(visit.id, 'reserve', original.key, { ...original.payload, slotId: 'different' }), /different terms/);
    assert.equal(journal.latest(visit.id, 'reserve').status, 'blocked');

    const interrupted = { ...fixture, reserve(...args) {
      assert.equal(fixture.reserve(...args).status, 'confirmed');
      throw new Error('Interrupted after booking');
    } };
    assert.throws(() => runVisit(visit, interrupted, journal, now), /Interrupted after booking/);
    assert.equal(journal.latest(visit.id, 'reserve').status, 'prepared');
    assert.deepEqual(fixture.inspect().reservations.map(({ slotId }) => slotId), ['slot-demo-3pm']);
  });

  fixture.putSlot({
    ...mondayVisit, id: 'slot-demo-2pm', revision: 1,
    start: '2026-11-24T14:00:00+05:30', end: '2026-11-24T14:45:00+05:30'
  });
  withJournal(journal => {
    visit = runVisit(visit, fixture, journal, now);
    assert.equal(visit.status, 'verified');
    assert.equal(visit.reservation.slotId, 'slot-demo-3pm');
    assert.deepEqual(fixture.inspect().reservations, [visit.reservation]);

    const confirmed = journal.latest(visit.id, 'reserve');
    assert.equal(journal.prepare(visit.id, 'reserve', confirmed.key, confirmed.payload).status, 'confirmed');
  });
});

test('a replacement for a proven-absent reservation prevents stale dispatch of the original', t => {
  const now = new Date('2026-11-23T09:00:00+05:30');
  const clock = () => now;
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-visit-replacement-'));
  const fixture = openVisitFixture({ dataDir, clock });
  const database = new DatabaseSync(':memory:');
  t.after(() => {
    database.close();
    fixture.close();
    rmSync(dataDir, { force: true, recursive: true });
  });
  fixture.reset();
  const visit = seedHousehold(now, true).find(record => record.kind === 'visit');
  const journal = openActionJournal(database, () => visit, action => action(), clock);
  const replacement = fixture.putSlot({
    ...mondayVisit, id: 'slot-demo-4pm',
    start: '2026-11-24T16:00:00+05:30', end: '2026-11-24T17:00:00+05:30'
  });
  const protectedEvent = {
    id: 'calendar-demo-new-conflict', title: 'Synthetic appointment',
    start: '2026-11-24T15:00:00+05:30', end: '2026-11-24T16:00:00+05:30'
  };
  let recovered;
  const delayed = {
    ...journal,
    prepare(...args) {
      const original = journal.prepare(...args);
      if (original.operation === 'reserve') {
        fixture.putCalendarEvent(protectedEvent);
        recovered = runVisit(visit, fixture, journal, now);
        fixture.putCalendarEvent({ ...protectedEvent, start: replacement.end, end: mondayVisit.windowEnd });
      }
      return original;
    }
  };

  runVisit(visit, fixture, delayed, now);
  assert.equal(recovered.status, 'verified');
  assert.equal(recovered.reservation.slotId, replacement.id);
  const native = fixture.inspect();
  assert.deepEqual(native.reservations, [recovered.reservation]);
  assert.equal(native.attempts.filter(attempt => attempt.operation === 'reserve').length, 1);
  assert.deepEqual(runVisit(recovered, fixture, journal, now), recovered);
});

test('a stale booking runner cannot erase an ambiguous commit when permission is withdrawn', async t => {
  for (const pause of ['withdraw slots', 'stop tracking']) {
    await t.test(pause, t => {
      let now = new Date('2026-11-23T09:00:00+05:30');
      const clock = () => now;
      const dataDir = mkdtempSync(join(tmpdir(), 'relay-visit-concurrent-recovery-'));
      const firstProvider = openVisitFixture({ dataDir, clock });
      const secondProvider = openVisitFixture({ dataDir, clock });
      const original = seedHousehold(now, true).find(record => record.kind === 'visit');
      let current = original;
      const first = openVisitJournal(dataDir, () => current, clock);
      const second = openVisitJournal(dataDir, () => current, clock);
      t.after(() => {
        first.close();
        second.close();
        firstProvider.close();
        secondProvider.close();
        rmSync(dataDir, { force: true, recursive: true });
      });
      firstProvider.reset();
      firstProvider.putSlot({
        ...mondayVisit, id: 'later-alternative', start: '2026-11-24T16:00:00+05:30', end: '2026-11-24T17:00:00+05:30'
      });
      const operations = pause === 'stop tracking' ? Object.keys(original.grants) : ['slots'];
      const setGrants = status => {
        const grants = { ...current.grants };
        for (const operation of operations) grants[operation] = makeGrant(operation, original.visit, status, grants[operation], now);
        current = { ...current, grants };
      };
      const delayed = {
        ...first.journal,
        prepare(...args) {
          const intent = first.journal.prepare(...args);
          if (intent.operation === 'reserve') {
            secondProvider.failNextReservationReply();
            current = runVisit(current, secondProvider, second.journal, now);
            assert.equal(current.issue, 'reservation-unknown');
            setGrants('withdrawn');
            if (pause === 'stop tracking') current = { ...current, status: 'stopped' };
          }
          return intent;
        }
      };

      runVisit(original, firstProvider, delayed, now);
      const before = firstProvider.inspect();
      assert.equal(before.reservations.length, 1);
      assert.equal(before.attempts.filter(item => item.operation === 'reserve').length, 1);
      const pending = second.journal.latest(original.id, 'reserve').status;
      const gated = runVisit(current, secondProvider, second.journal, now);
      if (pause === 'stop tracking') assert.equal(gated, current);
      assert.deepEqual(firstProvider.inspect().attempts, before.attempts);

      now = new Date('2026-11-24T09:00:00+05:30');
      current = { ...current, status: 'open' };
      setGrants('allowed');
      const recovered = runVisit(current, secondProvider, second.journal, now);
      const after = firstProvider.inspect();
      assert.deepEqual(after.reservations, before.reservations);
      assert.equal(pending, 'unknown');
      assert.equal(recovered.status, 'verified');
      assert.deepEqual(recovered.reservation, before.reservations[0]);
      assert.equal(after.calendar.filter(event => event.reservationId).length, 1);
    });
  }
});

test('appointment writes require permission inside their provider transaction', async t => {
  for (const [operation, method] of [['reserve', 'reserve'], ['calendar', 'addToCalendar']]) {
    await t.test(operation, t => {
      let now = new Date('2026-11-23T09:00:00+05:30');
      const expiresAt = '2026-11-23T04:00:00.000Z';
      const clock = () => now;
      const dataDir = mkdtempSync(join(tmpdir(), 'relay-visit-expiry-'));
      const fixture = openVisitFixture({ dataDir, clock });
      const database = new DatabaseSync(':memory:');
      t.after(() => {
        database.close();
        fixture.close();
        rmSync(dataDir, { force: true, recursive: true });
      });
      fixture.reset();
      const visit = seedHousehold(now, true).find(record => record.kind === 'visit');
      visit.grants[operation].expiresAt = expiresAt;
      const journal = openActionJournal(database, () => visit, action => action(), clock);
      const delayed = {
        ...fixture,
        [method](...args) {
          now = new Date(expiresAt);
          return fixture[method](...args);
        }
      };

      const result = runVisit(visit, delayed, journal, now);
      const native = fixture.inspect();
      const reservationExpected = operation === 'calendar';
      assert.equal(result.status, reservationExpected ? 'booked' : 'open');
      assert.equal(native.reservations.length, reservationExpected ? 1 : 0);
      assert.equal(native.calendar.filter(event => event.reservationId).length, 0);
      assert.equal(native.attempts.at(-1).status, 'blocked');
      assert.equal(native.attempts.at(-1).reason, 'permission');
    });
  }
});
