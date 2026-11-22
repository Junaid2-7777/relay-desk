import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const mondayVisit = Object.freeze({
  issuer: 'provider-demo-broadband',
  service: 'broadband-service-visit',
  subject: 'household-demo-broadband',
  zone: 'Asia/Kolkata',
  windowStart: '2026-11-24T12:00:00+05:30',
  windowEnd: '2026-11-24T18:00:00+05:30'
});

const slotIntervals = [
  { id: 'slot-demo-11am', start: '2026-11-24T11:00:00+05:30', end: '2026-11-24T12:00:00+05:30' },
  { id: 'slot-demo-3pm', start: '2026-11-24T15:00:00+05:30', end: '2026-11-24T16:00:00+05:30' }
];

const rowRecord = row => row ? JSON.parse(row.record) : null;
const interval = ({ start, end }) => ({ start, end });
const blocked = reason => ({ status: 'blocked', reason });

function validInterval(start, end) {
  return typeof start === 'string' && typeof end === 'string' && Date.parse(start) < Date.parse(end);
}

function intervalBounds({ start, end }) {
  if (!validInterval(start, end)) throw new TypeError('A valid start and end are required.');
  return [Date.parse(start), Date.parse(end)];
}

export function openVisitFixture({ dataDir, clock = () => new Date() }) {
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, 'providers.sqlite'));
  database.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS visit_slots (
      id TEXT PRIMARY KEY, issuer TEXT NOT NULL, service TEXT NOT NULL,
      subject TEXT NOT NULL, record TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS visit_reservations (
      id TEXT PRIMARY KEY, operationKey TEXT NOT NULL UNIQUE, slotId TEXT NOT NULL UNIQUE,
      request TEXT NOT NULL, record TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS visit_calendar_events (
      id TEXT PRIMARY KEY, operationKey TEXT UNIQUE, reservationId TEXT UNIQUE,
      startMs INTEGER NOT NULL, endMs INTEGER NOT NULL, record TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS visit_attempts (
      id INTEGER PRIMARY KEY, operation TEXT NOT NULL, operationKey TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT, attemptedAt TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS visit_reads (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, scope TEXT NOT NULL, checkedAt TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS visit_faults (name TEXT PRIMARY KEY) STRICT;
  `);
  const slotById = database.prepare('SELECT record FROM visit_slots WHERE id = ?');
  const slotsForScope = database.prepare(`
    SELECT record FROM visit_slots WHERE issuer = ? AND service = ? AND subject = ?
      AND id NOT IN (SELECT slotId FROM visit_reservations)
    ORDER BY id
  `);
  const saveSlot = database.prepare(`
    INSERT INTO visit_slots VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET issuer = excluded.issuer, service = excluded.service,
      subject = excluded.subject, record = excluded.record
      WHERE visit_slots.record = excluded.record
        OR json_extract(visit_slots.record, '$.revision') < json_extract(excluded.record, '$.revision')
  `);
  const findReservationByKey = database.prepare('SELECT request, record FROM visit_reservations WHERE operationKey = ?');
  const findReservation = database.prepare('SELECT record FROM visit_reservations WHERE id = ?');
  const bookedSlot = database.prepare('SELECT id FROM visit_reservations WHERE slotId = ?');
  const insertReservation = database.prepare('INSERT INTO visit_reservations VALUES (?, ?, ?, ?, ?)');
  const findCalendarByKey = database.prepare('SELECT record FROM visit_calendar_events WHERE operationKey = ?');
  const findCalendarByReservation = database.prepare('SELECT record FROM visit_calendar_events WHERE reservationId = ?');
  const insertCalendar = database.prepare('INSERT INTO visit_calendar_events VALUES (?, ?, ?, ?, ?, ?)');
  const writeExternalCalendar = database.prepare(`
    INSERT INTO visit_calendar_events VALUES (?, NULL, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET startMs = excluded.startMs, endMs = excluded.endMs, record = excluded.record
      WHERE visit_calendar_events.operationKey IS NULL
  `);
  const busyCalendar = database.prepare(`
    SELECT record FROM visit_calendar_events WHERE startMs < ? AND endMs > ?
    ORDER BY startMs, endMs, id
  `);
  const saveAttempt = database.prepare(`
    INSERT INTO visit_attempts(operation, operationKey, status, reason, attemptedAt) VALUES (?, ?, ?, ?, ?)
  `);
  const saveRead = database.prepare('INSERT INTO visit_reads(source, scope, checkedAt) VALUES (?, ?, ?)');
  const queueFault = database.prepare('INSERT OR IGNORE INTO visit_faults VALUES (?)');
  const consumeFault = database.prepare('DELETE FROM visit_faults WHERE name = ?');

  const timestamp = () => clock().toISOString();

  function transaction(action) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function putSlot({ id, issuer, service, subject, zone, start, end, revision, active = true, feeMinor = 0, currency = 'INR' }) {
    intervalBounds({ start, end });
    if (!Number.isSafeInteger(feeMinor) || feeMinor < 0) throw new TypeError('A valid slot fee is required.');
    const previous = rowRecord(slotById.get(id));
    const nextRevision = revision ?? (previous ? previous.revision + 1 : 1);
    const slot = { id, issuer, service, subject, zone, start, end, revision: nextRevision, active, feeMinor, currency };
    const record = JSON.stringify(slot);
    if (!Number.isSafeInteger(nextRevision) || nextRevision < 1) throw new TypeError('A valid slot revision is required.');
    if (!saveSlot.run(id, issuer, service, subject, record).changes) {
      throw new TypeError('A changed slot needs a newer revision.');
    }
    return slot;
  }

  function putCalendarEvent({ id, start, end, title }) {
    const [startMs, endMs] = intervalBounds({ start, end });
    const event = { id, start, end, title, reservationId: null, protected: true };
    if (!writeExternalCalendar.run(id, startMs, endMs, JSON.stringify(event)).changes) {
      throw new Error('This event belongs to a provider reservation.');
    }
    return event;
  }

  function busy(range) {
    const [start, end] = intervalBounds(range);
    return busyCalendar.all(end, start).map(rowRecord);
  }

  function recordAttempt(operation, key, result) {
    saveAttempt.run(operation, key, result.status, result.reason ?? null, timestamp());
    return result;
  }

  function read(source, scope, records) {
    return transaction(() => {
      saveRead.run(source, JSON.stringify(scope), timestamp());
      return records();
    });
  }

  function requiredKey(key) {
    if (typeof key !== 'string' || !key) throw new TypeError('An operation key is required.');
  }

  function reserve(payload, authorize = () => false) {
    const { key, issuer, service, subject, zone, windowStart, windowEnd, slotId, revision } = payload;
    requiredKey(key);
    return transaction(() => {
      const finish = result => recordAttempt('reserve', key, result);
      const request = JSON.stringify({ key, issuer, service, subject, zone, windowStart, windowEnd, slotId, revision });
      const previous = findReservationByKey.get(key);
      if (previous) {
        return finish(previous.request === request
          ? { status: 'confirmed', reservation: rowRecord(previous) }
          : blocked('key-conflict'));
      }
      const slot = typeof slotId === 'string' ? rowRecord(slotById.get(slotId)) : null;
      if (!slot || slot.issuer !== issuer || slot.service !== service || slot.subject !== subject || slot.zone !== zone) {
        return finish(blocked('slot-scope'));
      }
      if (!slot.active || bookedSlot.get(slotId)) return finish(blocked('slot-unavailable'));
      if (slot.revision !== revision) return finish(blocked('slot-revised'));
      if (slot.feeMinor !== 0) return finish(blocked('slot-fee'));
      if (!validInterval(windowStart, windowEnd) ||
          Date.parse(slot.start) < Date.parse(windowStart) || Date.parse(slot.end) > Date.parse(windowEnd)) {
        return finish(blocked('outside-window'));
      }
      if (busy(slot).length) return finish(blocked('calendar-conflict'));
      const authorizedRequest = {
        key, issuer, service, subject, zone, windowStart, windowEnd, slotId, revision,
        ...interval(slot), feeMinor: slot.feeMinor, currency: slot.currency
      };
      if (authorize(Object.freeze(authorizedRequest)) !== true) return finish(blocked('permission'));

      const id = `visit-reservation-${createHash('sha256').update(key).digest('hex')}`;
      const reservation = {
        id, key, issuer, service, subject, zone, slotId, revision, ...interval(slot),
        feeMinor: slot.feeMinor, currency: slot.currency, status: 'confirmed', confirmedAt: timestamp()
      };
      insertReservation.run(id, key, slotId, request, JSON.stringify(reservation));
      return finish(consumeFault.run('reservation-reply').changes
        ? { status: 'unknown', reason: 'reply-lost' }
        : { status: 'confirmed', reservation });
    });
  }

  function addToCalendar({ key, reservationId }, authorize = () => false) {
    requiredKey(key);
    return transaction(() => {
      const finish = result => recordAttempt('calendar.add', key, result);
      const previous = rowRecord(findCalendarByKey.get(key));
      if (previous) {
        return finish(previous.reservationId === reservationId
          ? { status: 'recorded', event: previous }
          : blocked('key-conflict'));
      }
      const reservation = typeof reservationId === 'string' ? rowRecord(findReservation.get(reservationId)) : null;
      if (!reservation) return finish(blocked('reservation-missing'));
      if (authorize(Object.freeze({ ...reservation, key, reservationId })) !== true) return finish(blocked('permission'));
      if (findCalendarByReservation.get(reservationId)) return finish(blocked('reservation-recorded'));
      const [conflict] = busy(reservation);
      if (conflict) return finish({ status: 'conflict', interval: interval(conflict) });
      if (consumeFault.run('calendar-write').changes) return finish({ status: 'failed', reason: 'calendar-unavailable' });
      const event = {
        id: `visit-event-${reservation.id}`,
        reservationId,
        ...interval(reservation),
        zone: reservation.zone,
        title: reservation.service,
        protected: false
      };
      const [start, end] = intervalBounds(event);
      insertCalendar.run(event.id, key, reservationId, start, end, JSON.stringify(event));
      return finish({ status: 'recorded', event });
    });
  }

  return {
    reset() {
      transaction(() => {
        database.exec(`
          DELETE FROM visit_reservations; DELETE FROM visit_slots; DELETE FROM visit_calendar_events;
          DELETE FROM visit_attempts; DELETE FROM visit_reads; DELETE FROM visit_faults;
        `);
        const { issuer, service, subject, zone } = mondayVisit;
        for (const slot of slotIntervals) putSlot({ ...slot, issuer, service, subject, zone });
        putCalendarEvent({
          id: 'calendar-demo-protected',
          start: slotIntervals[0].start,
          end: slotIntervals[0].end,
          title: 'Synthetic private calendar title'
        });
      });
    },
    putSlot,
    putCalendarEvent,
    readSlots({ issuer, service, subject }) {
      return read('slots', { issuer, service, subject }, () => slotsForScope.all(issuer, service, subject).map(rowRecord));
    },
    readFreeBusy({ start, end }) {
      return read('freeBusy', { start, end }, () => busy({ start, end }).map(interval));
    },
    reserve,
    reservationByKey: key => read('reservation', { key }, () => rowRecord(findReservationByKey.get(key))),
    addToCalendar,
    calendarByReservation: reservationId => read('calendar', { reservationId }, () =>
      rowRecord(findCalendarByReservation.get(reservationId))),
    calendarConflictForReservation: reservationId => read('calendarConflict', { reservationId }, () => {
      const reservation = rowRecord(findReservation.get(reservationId));
      if (!reservation) return null;
      const conflict = busy(reservation).find(event => event.reservationId !== reservationId);
      return conflict ? interval(conflict) : null;
    }),
    failNextReservationReply: () => queueFault.run('reservation-reply'),
    failNextCalendarWrite: () => queueFault.run('calendar-write'),
    inspect() {
      return {
        slots: database.prepare('SELECT record FROM visit_slots ORDER BY id').all().map(rowRecord),
        reservations: database.prepare('SELECT record FROM visit_reservations ORDER BY rowid').all().map(rowRecord),
        calendar: database.prepare('SELECT record FROM visit_calendar_events ORDER BY startMs, id').all().map(rowRecord),
        attempts: database.prepare('SELECT operation, operationKey, status, reason, attemptedAt FROM visit_attempts ORDER BY id')
          .all().map(row => ({ ...row })),
        reads: database.prepare('SELECT source, scope, checkedAt FROM visit_reads ORDER BY id').all()
          .map(row => ({ ...row, scope: JSON.parse(row.scope) }))
      };
    },
    close: () => database.close()
  };
}
