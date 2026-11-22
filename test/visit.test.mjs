import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openActionJournal } from '../src/action-journal.mjs';
import { seedHousehold } from '../src/household.mjs';
import { mondayVisit, openVisitFixture } from '../src/visit-fixture.mjs';
import { runVisit } from '../src/visit.mjs';

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
    try {
      action(openActionJournal(database, () => visit, transaction, clock));
    } finally {
      database.close();
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
