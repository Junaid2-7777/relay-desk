import { activeGrant } from './household.mjs';

const scopeFields = ['issuer', 'service', 'subject', 'zone', 'windowStart', 'windowEnd'];
const subjectFields = ['issuer', 'service', 'subject', 'zone'];
const intervalFields = ['start', 'end'];
const eventFields = [...intervalFields, 'zone'];
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
  return { ...record, status, issue, conflict: null, conflictChoice: null, ...proof };
}

function dispatchVisit(journal, record, operation, key, payload, action, authorizePreparation) {
  const prepared = journal.prepare(record.id, operation, key, payload, authorizePreparation);
  if (!prepared) return undefined;
  return journal.dispatch(record.id, (current, now, readClock) => action(current, prepared.payload, now, readClock));
}

function readWithGrant(record, current, operation, instant, read) {
  const authorize = at => permittedAtDispatch(record, current, [operation], +at);
  return authorize(instant) ? read(authorize) : undefined;
}

function readUnderGrant(record, operation, journal, instant, read) {
  if (!grantFor(record, operation, instant)) return undefined;
  return journal.dispatch(record.id, (current, now) =>
    readWithGrant(record, current, operation, +(now ?? instant), read));
}

export function confirmVisitConflict(record, fixture, journal, clock) {
  const { reservation, conflict } = record;
  if (record.status !== 'booked' || record.issue !== 'calendar-conflict' || !reservation || !conflict) return null;
  const original = journal.latest(record.id, 'reserve');
  const now = +clock();
  if (!original || !exactScope(record.visit, scopeFor(original.payload)) || !reservationProof(reservation, original.payload) ||
      !grantFor(record, 'slots', now) || !grantFor(record, 'freeBusy', now)) return null;
  const native = reservationProof(readWithGrant(record, record, 'slots', now, authorize =>
    fixture.reservationByKey(original.key, authorize)), original.payload);
  if (native?.id !== reservation.id) return null;
  const interval = readWithGrant(record, record, 'freeBusy', +clock(), authorize =>
    fixture.calendarConflictForReservation(native.id, authorize));
  if (!sameFields(intervalFields, conflict, interval)) return null;
  return { reservationId: native.id, start: interval.start, end: interval.end };
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
      const native = readWithGrant(record, current, 'slots', time, authorize =>
        fixture.reservationByKey(original.key, authorize));
      const proof = reservationProof(native, original.payload);
      if (proof) {
        journal.mark(original.key, 'confirmed');
        return { proof };
      }
      if (native !== null || original.status === 'confirmed') return { issue: 'reservation-unknown' };
    }

    const calendarScope = { start: visit.windowStart, end: visit.windowEnd };
    const busy = readWithGrant(record, current, 'freeBusy', time, authorize =>
      fixture.readFreeBusy(calendarScope, authorize));
    const slots = readWithGrant(record, current, 'slots', time, authorize => fixture.readSlots(visit, authorize));
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
  const conflictChoice = record.conflictChoice?.reservationId === reservation.id ? record.conflictChoice : null;
  const previousConflict = record.reservation?.id === reservation.id ? record.conflict : null;
  const booked = withState(record, 'booked', 'calendar-pending', { reservation, calendarEvent: null, conflictChoice });
  const readConflict = () => readUnderGrant(record, 'freeBusy', journal, instant, authorize =>
    fixture.calendarConflictForReservation(reservation.id, authorize));
  function conflicting(conflict, calendarEvent = null, lastConflict = previousConflict) {
    const choice = sameFields(intervalFields, conflict, lastConflict) &&
      sameFields(intervalFields, conflictChoice, conflict) ? conflictChoice : null;
    return withState(booked, 'booked', 'calendar-conflict', { calendarEvent, conflict, conflictChoice: choice });
  }
  function presentCalendar(event, lastConflict) {
    const observed = readConflict();
    const conflict = observed === undefined ? lastConflict : observed;
    return conflict ? conflicting(conflict, event, lastConflict) : withState(booked, 'verified', null, { calendarEvent: event });
  }
  if (!grantFor(record, 'calendar', instant)) {
    const previousProof = calendarProof(record.calendarEvent, reservation);
    if (previousConflict || conflictChoice) {
      const observed = readConflict();
      const conflict = observed === undefined ? previousConflict : observed;
      return conflict ? conflicting(conflict, previousProof) : { ...booked, calendarEvent: previousProof };
    }
    return previousProof && record.status === 'verified'
      ? withState(booked, 'verified', null, { calendarEvent: previousProof })
      : { ...booked, calendarEvent: previousProof };
  }

  const previous = journal.latest(record.id, 'calendar');
  if (previous && previous.payload.reservationId !== reservation.id) return booked;
  const native = readUnderGrant(record, 'calendar', journal, instant, authorize =>
    fixture.calendarByReservation(reservation.id, authorize));
  if (native === undefined) return booked;
  const existing = calendarProof(native, reservation);
  if (native && !existing) return booked;
  if (existing) {
    if (previous?.status !== 'recorded' && previous) journal.mark(previous.key, 'recorded');
    return presentCalendar(existing, previousConflict);
  }

  if (previousConflict || conflictChoice) {
    const observed = readConflict();
    const conflict = observed === undefined ? previousConflict : observed;
    if (conflict) return conflicting(conflict);
    if (observed === undefined || conflictChoice?.choice === 'handle') return booked;
  }
  if (!grantFor(record, 'freeBusy', instant)) return booked;
  const key = previous?.key ?? `visit:${record.id}:calendar:${reservation.id}`;
  const calendarGrants = ['freeBusy', 'calendar'];
  const result = dispatchVisit(journal, record, 'calendar', key, { key, reservationId: reservation.id }, (current, payload, now, readClock) => {
    if (!permittedAtDispatch(record, current, calendarGrants, +(now ?? instant)) ||
        (current.conflictChoice?.choice === 'handle' && current.conflictChoice.reservationId === reservation.id)) {
      return { status: 'blocked', reason: 'permission' };
    }
    return fixture.addToCalendar(payload, fresh =>
      permittedAtDispatch(record, current, calendarGrants, +readClock()) &&
      fresh.reservationId === reservation.id && sameFields(eventFields, fresh, reservation));
  });
  if (result?.status === 'conflict') {
    journal.mark(key, 'conflict');
    return conflicting(result.interval, null, null);
  }
  if (result?.status !== 'recorded') {
    journal.mark(key, result?.status === 'blocked' ? 'blocked' : 'failed');
    return booked;
  }
  const event = calendarProof(readUnderGrant(record, 'calendar', journal, instant, authorize =>
    fixture.calendarByReservation(reservation.id, authorize)), reservation);
  journal.mark(key, event ? 'recorded' : 'failed');
  return event ? presentCalendar(event, null) : booked;
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
  const authorizePreparation = (current, time) => current.revision === record.revision &&
    permittedAtDispatch(record, current, bookingGrants, +time);
  const result = dispatchVisit(journal, record, 'reserve', key, request, (current, payload, currentTime, readClock) => {
    const active = journal.latest(record.id, 'reserve');
    if (active?.key !== key || !['prepared', 'unknown'].includes(active.status)) {
      return { status: 'blocked', reason: 'reservation-superseded' };
    }
    if (!permittedAtDispatch(record, current, bookingGrants, +(currentTime ?? instant))) {
      // A different runner may have dispatched this intent before access changed.
      return { status: 'unknown' };
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
  }, authorizePreparation);
  if (result?.status === 'blocked' && result.reason !== 'key-conflict') {
    if (result.reason === 'reservation-superseded') return unresolved('reservation-unknown');
    return unresolved(result.reason === 'permission' ? 'visit-permission' : 'slot-unavailable');
  }
  if (result?.status !== 'confirmed') return unresolved('reservation-unknown');
  const reservation = reservationProof(readUnderGrant(record, 'slots', journal, instant, authorize =>
    fixture.reservationByKey(key, authorize)), request);
  journal.mark(key, reservation ? 'confirmed' : 'unknown');
  return reservation ? runCalendar(record, reservation, fixture, journal, instant) : unresolved('reservation-unknown');
}
