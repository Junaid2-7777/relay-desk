import { activeGrant } from './household.mjs';

const scopeFields = ['issuer', 'service', 'subject', 'zone', 'windowStart', 'windowEnd'];
const subjectFields = ['issuer', 'service', 'subject', 'zone'];
const eventFields = ['start', 'end', 'zone'];
const bookingGrants = ['freeBusy', 'slots', 'reserve'];

function sameFields(fields, left, right) {
  return fields.every(field => typeof left?.[field] === 'string' && left[field] === right?.[field]);
}

function exactScope(left, right) {
  return sameFields(scopeFields, left, right) &&
    Object.keys(left).length === scopeFields.length && Object.keys(right).length === scopeFields.length;
}

function scopeFor(payload) {
  return Object.fromEntries(scopeFields.map(field => [field, payload[field]]));
}

function grantFor(record, operation, instant) {
  const grant = record?.grants?.[operation];
  if (grant?.operation === operation && activeGrant(grant, instant) && Number.isSafeInteger(grant.revision) &&
      grant.revision > 0 && exactScope(grant.scope, record.visit)) {
    return grant;
  }
  return null;
}

function permittedAtDispatch(record, current, operations, instant) {
  return current?.status !== 'stopped' && exactScope(record.visit, current?.visit) && operations.every(operation => {
    const before = grantFor(record, operation, instant);
    return before && grantFor(current, operation, instant)?.revision === before.revision;
  });
}

function eligibleSlot(slot, visit, busy, instant) {
  const start = Date.parse(slot.start);
  const end = Date.parse(slot.end);
  return sameFields(subjectFields, slot, visit) && slot.active === true && slot.feeMinor === 0 &&
    start > instant && start >= Date.parse(visit.windowStart) && end <= Date.parse(visit.windowEnd) && start < end &&
    !busy.some(interval => Date.parse(interval.start) < end && Date.parse(interval.end) > start);
}

function reservationProof(native, expected) {
  if (native?.status !== 'confirmed' || typeof native.id !== 'string' || !native.id ||
      !sameFields(subjectFields, native, expected) || native.key !== expected.key ||
      native.slotId !== expected.slotId || native.revision !== expected.revision ||
      native.start !== expected.start || native.end !== expected.end ||
      native.currency !== expected.currency || native.feeMinor !== 0) return null;
  const { id, key, issuer, service, subject, zone, slotId, revision, start, end, feeMinor, currency, status, confirmedAt } = native;
  return { id, key, issuer, service, subject, zone, slotId, revision, start, end, feeMinor, currency, status, confirmedAt };
}

function calendarProof(native, reservation) {
  if (typeof native?.id !== 'string' || !native.id || native.reservationId !== reservation.id ||
      !sameFields(eventFields, native, reservation)) return null;
  const { id, reservationId, start, end, zone } = native;
  return { id, reservationId, start, end, zone };
}

function withState(record, status, issue = null, proof = {}) {
  return { ...record, status, issue, conflict: null, ...proof };
}

function dispatchVisit(journal, record, operation, key, payload, action) {
  const prepared = journal.prepare(record.id, operation, key, payload);
  return journal.dispatch(record.id, (current, now, readClock) => action(current, prepared.payload, now, readClock));
}

function readUnderGrant(record, operation, journal, instant, read) {
  if (!grantFor(record, operation, instant)) return undefined;
  return journal.dispatch(record.id, (current, now) =>
    permittedAtDispatch(record, current, [operation], +(now ?? instant)) ? read() : undefined);
}

function selectSlot(record, fixture, journal, instant) {
  return journal.dispatch(record.id, (current, now) => {
    const time = +(now ?? instant);
    const { visit } = record;
    const previous = journal.latest(record.id, 'reserve');
    const original = previous?.status === 'blocked' ? null : previous;
    const permitted = operation => permittedAtDispatch(record, current, [operation], time);
    if (original) {
      if (!permitted('slots') || !exactScope(visit, scopeFor(original.payload))) {
        return { issue: 'reservation-unknown' };
      }
      const native = fixture.reservationByKey(original.key);
      const proof = reservationProof(native, original.payload);
      if (proof) {
        journal.mark(original.key, 'confirmed');
        return { proof };
      }
      if (native !== null || original.status === 'confirmed') return { issue: 'reservation-unknown' };
    }

    const calendarScope = { start: visit.windowStart, end: visit.windowEnd };
    const busy = permitted('freeBusy') ? fixture.readFreeBusy(calendarScope) : undefined;
    const slots = permitted('slots') ? fixture.readSlots(visit) : undefined;
    if (!busy || !slots || !permitted('reserve')) {
      return { issue: original ? 'reservation-unknown' : 'visit-permission' };
    }
    const candidates = slots.filter(slot => eligibleSlot(slot, visit, busy, time));
    if (original) {
      const candidate = candidates.find(slot => slot.id === original.payload.slotId && slot.revision === original.payload.revision);
      if (candidate) return { candidate, retry: original };
      // The original is absent and ineligible. Retire it under the same lock that guards dispatch.
      journal.mark(original.key, 'blocked');
    }
    const [candidate] = candidates.sort((left, right) => Date.parse(left.start) - Date.parse(right.start) || left.id.localeCompare(right.id));
    return candidate ? { candidate } : { issue: 'slot-unavailable' };
  });
}

function runCalendar(record, reservation, fixture, journal, instant) {
  const booked = withState(record, 'booked', 'calendar-pending', { reservation, calendarEvent: null });
  if (!grantFor(record, 'calendar', instant)) {
    const previousProof = calendarProof(record.calendarEvent, reservation);
    if (record.issue === 'calendar-conflict') {
      return withState(booked, 'booked', 'calendar-conflict', { calendarEvent: previousProof, conflict: record.conflict });
    }
    return previousProof ? withState(booked, 'verified', null, { calendarEvent: previousProof }) : booked;
  }

  const previous = journal.latest(record.id, 'calendar');
  if (previous && previous.payload.reservationId !== reservation.id) return booked;
  const native = readUnderGrant(record, 'calendar', journal, instant, () => fixture.calendarByReservation(reservation.id));
  if (native === undefined) return booked;
  const existing = calendarProof(native, reservation);
  if (native && !existing) return booked;
  if (existing) {
    if (previous?.status !== 'recorded' && previous) journal.mark(previous.key, 'recorded');
    const currentConflict = readUnderGrant(record, 'freeBusy', journal, instant, () => fixture.calendarConflictForReservation(reservation.id));
    const conflict = currentConflict === undefined ? record.conflict : currentConflict;
    return conflict
      ? withState(booked, 'booked', 'calendar-conflict', { calendarEvent: existing, conflict })
      : withState(booked, 'verified', null, { calendarEvent: existing });
  }

  if (!grantFor(record, 'freeBusy', instant)) return booked;
  if (record.issue === 'calendar-conflict') {
    const conflict = readUnderGrant(record, 'freeBusy', journal, instant, () => fixture.calendarConflictForReservation(reservation.id));
    if (conflict !== null) {
      return withState(booked, 'booked', 'calendar-conflict', { conflict: conflict ?? record.conflict });
    }
  }
  const key = previous?.key ?? `visit:${record.id}:calendar:${reservation.id}`;
  const calendarGrants = ['freeBusy', 'calendar'];
  const result = dispatchVisit(journal, record, 'calendar', key, { key, reservationId: reservation.id }, (current, payload, now, readClock) => {
    if (!permittedAtDispatch(record, current, calendarGrants, +(now ?? instant))) {
      return { status: 'blocked', reason: 'permission' };
    }
    return fixture.addToCalendar(payload, fresh =>
      permittedAtDispatch(record, current, calendarGrants, +readClock()) &&
      fresh.reservationId === reservation.id && sameFields(eventFields, fresh, reservation));
  });
  if (result?.status === 'conflict') {
    journal.mark(key, 'conflict');
    return withState(booked, 'booked', 'calendar-conflict', { conflict: result.interval });
  }
  if (result?.status !== 'recorded') {
    journal.mark(key, result?.status === 'blocked' ? 'blocked' : 'failed');
    return record.issue === 'calendar-conflict'
      ? withState(booked, 'booked', 'calendar-conflict', { conflict: record.conflict })
      : booked;
  }
  const event = calendarProof(readUnderGrant(record, 'calendar', journal, instant, () =>
    fixture.calendarByReservation(reservation.id)), reservation);
  journal.mark(key, event ? 'recorded' : 'failed');
  return event ? withState(booked, 'verified', null, { calendarEvent: event }) : booked;
}

export function runVisit(record, fixture, journal, now) {
  if (record.status === 'stopped') return record;
  const instant = +new Date(now);
  const unresolved = issue => withState(record, 'open', issue, { reservation: null, calendarEvent: null });
  const { visit } = record;
  if (record.reservation) {
    const previous = journal.latest(record.id, 'reserve');
    if (!previous || !exactScope(visit, scopeFor(previous.payload)) ||
        !reservationProof(record.reservation, previous.payload)) return unresolved('reservation-unknown');
    return runCalendar(record, record.reservation, fixture, journal, instant);
  }

  const { candidate, issue, proof, retry } = selectSlot(record, fixture, journal, instant);
  if (proof) return runCalendar(record, proof, fixture, journal, instant);
  if (issue) return unresolved(issue);

  const { id: slotId, revision, start, end, feeMinor, currency } = candidate;
  const key = retry?.key ?? `visit:${record.id}:reserve:${encodeURIComponent(slotId)}:${revision}`;
  const request = retry?.payload ?? { key, ...visit, slotId, revision, start, end, feeMinor, currency };
  const result = dispatchVisit(journal, record, 'reserve', key, request, (current, payload, currentTime, readClock) => {
    const active = journal.latest(record.id, 'reserve');
    if (active?.key !== key || !['prepared', 'unknown'].includes(active.status)) {
      return { status: 'blocked', reason: 'reservation-superseded' };
    }
    if (!permittedAtDispatch(record, current, bookingGrants, +(currentTime ?? instant))) {
      journal.mark(key, 'blocked');
      return { status: 'blocked', reason: 'permission' };
    }
    const attempt = fixture.reserve(payload, fresh => {
      const commitTime = +readClock();
      return permittedAtDispatch(record, current, bookingGrants, commitTime) &&
        sameFields(['start', 'end', 'currency'], fresh, payload) && fresh.feeMinor === payload.feeMinor &&
        Date.parse(fresh.start) > commitTime;
    });
    if (attempt?.status !== 'confirmed') {
      journal.mark(key, attempt?.status === 'blocked' && attempt.reason !== 'key-conflict' ? 'blocked' : 'unknown');
    }
    return attempt;
  });
  if (result?.status === 'blocked' && result.reason !== 'key-conflict') {
    if (result.reason === 'reservation-superseded') return unresolved('reservation-unknown');
    return unresolved(result.reason === 'permission' ? 'visit-permission' : 'slot-unavailable');
  }
  if (result?.status !== 'confirmed') return unresolved('reservation-unknown');
  const reservation = reservationProof(readUnderGrant(record, 'slots', journal, instant, () => fixture.reservationByKey(key)), request);
  journal.mark(key, reservation ? 'confirmed' : 'unknown');
  return reservation ? runCalendar(record, reservation, fixture, journal, instant) : unresolved('reservation-unknown');
}
