import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { activeGrant, makeGrant, scopes, seedHousehold } from '../src/household.mjs';
import { mondayRefund } from '../src/refund-fixture.mjs';
import { matchRefundCredit, refundAccess, refundGrant, refundScope, refundSources } from '../src/refund.mjs';
import { mondayVisit } from '../src/visit-fixture.mjs';
import { evidenceInstant, latestEvidence, zonedInstant } from '../shared/evidence-time.mjs';

export const morning = '2026-11-23T09:00:00+05:30';
export const cutoff = 'first-morning-checkpoint';
export const refundCheck = '2026-11-27';
export const morningClock = () => new Date(morning);
export const visitWindow = { start: mondayVisit.windowStart, end: mondayVisit.windowEnd };
export const coldChoices = [
  { errand: 'visit', scope: 'freeBusy', choice: 'allowed' },
  { errand: 'refund', scope: 'credits', choice: 'declined' }
];
export const permissionTargets = new Map([
  ['availability', { errand: 'visit', scope: 'freeBusy' }],
  ['slots', { errand: 'visit', scope: 'slots' }],
  ['booking', { errand: 'visit', scope: 'reserve' }],
  ['calendar', { errand: 'visit', scope: 'calendar' }],
  ['shop', { errand: 'refund', scope: 'merchant' }],
  ['credits', { errand: 'refund', scope: 'credits' }],
  ['bill', { errand: 'bill', scope: 'invoice' }]
]);

export const appointmentFields = ['issuer', 'service', 'subject', 'zone'];
export const exactTimes = ['start', 'end', 'zone'];
export const matching = (fields, actual, expected) => actual && expected && fields.every(field => actual[field] === expected[field]);
export const pick = (fields, record) => record ? Object.fromEntries(fields.map(field => [field, record[field]])) : null;
export const inspectFixtures = fixtures => Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, fixture.inspect()]));

const slotTerms = ['id', 'revision', 'start', 'end', 'feeMinor', 'currency', 'active'];
const bookedTerms = [...appointmentFields, 'revision', 'start', 'end', 'feeMinor', 'currency'];
const bookingKey = 'manual-morning-reservation';
const calendarKey = 'manual-morning-calendar';

export class ManualStepError extends Error {}

function countActions(entries) {
  const count = action => entries.filter(item => item.action === action).length;
  const billsPresented = entries.filter(item => item.action === 'bill-decision-presented');
  const invoiceRevisions = new Set(billsPresented.map(({ invoice }) => JSON.stringify(invoice)));
  return {
    consentChoices: count('consent'),
    missingFieldClarifications: count('clarify'),
    humanLookups: count('lookup'),
    slotChoices: count('choose-slot'),
    checkClicks: count('desk-check'),
    bookingSubmissions: count('submit-booking'),
    calendarSubmissions: count('submit-calendar'),
    billDecisionsPresented: billsPresented.length,
    distinctBillDecisions: invoiceRevisions.size,
    billDecisionsTaken: count('bill-decision-taken'),
    repeatPrompts: billsPresented.length - invoiceRevisions.size
  };
}

export function reportActions() {
  const setup = [];
  const ongoing = [];
  return {
    setup,
    ongoing,
    counts: ({ scripted = true } = {}) => ({
      setup: countActions(setup),
      ongoing: countActions(ongoing),
      total: {
        ...countActions([...setup, ...ongoing]),
        ...(scripted ? { attentionOccasions: Number(setup.length + ongoing.length > 0) } : {})
      }
    })
  };
}

export function presentBillDecision(actions, bill) {
  if (bill.issue !== 'bill-review') return;
  const { invoiceId, revision, payee, currency, amountMinor } = bill.invoice;
  actions.ongoing.push({ action: 'bill-decision-presented', invoice: { invoiceId, revision, payee, currency, amountMinor } });
}

function inScopeOffer(slot, scope, time) {
  const start = zonedInstant(slot.start);
  const end = zonedInstant(slot.end);
  return slot.active && slot.feeMinor === 0 && matching(appointmentFields, slot, scope) &&
    start > time && start < end && start >= zonedInstant(scope.windowStart) && end <= zonedInstant(scope.windowEnd);
}

function fitsAvailability(slot, busy) {
  const start = zonedInstant(slot.start);
  const end = zonedInstant(slot.end);
  return busy.every(interval => zonedInstant(interval.end) <= start || zonedInstant(interval.start) >= end);
}

export function createManualMorning(fixtures, warm, actions = reportActions(), clock = morningClock) {
  const [visit, bill] = seedHousehold(clock(), warm);
  const refund = {
    status: 'open', owner: 'Demo shop', refund: mondayRefund, checkDate: refundCheck, evidence: [],
    refundAccess: warm ? Object.fromEntries(refundSources.map(scope =>
      [scope, refundGrant(mondayRefund, scope, 'allowed', null, clock())])) : {}
  };
  const outcomes = { visit, bill, refund };
  const { visit: visitFixture, bill: billFixture, refund: refundFixture } = fixtures;
  const visitScope = visit.visit;
  const previousInvoice = bill.invoice;
  let busy;
  let slots;
  let selected;
  let bookingIntent;
  let calendarSubmitted = false;
  let merchantLinks = [];

  const canVisit = (operation, at = clock()) => {
    const grant = visit.grants[operation];
    return grant?.operation === operation && activeGrant(grant, at) && grant.revision > 0 && isDeepStrictEqual(grant.scope, visitScope);
  };
  const canRefund = (source, at = clock()) => {
    const grant = refund.refundAccess[source];
    return grant?.operation === 'read' && refundAccess(grant, at) === 'allowed' &&
      isDeepStrictEqual(grant.scope, refundScope(mondayRefund, source));
  };
  const canReadInvoice = (at = clock()) => {
    const grant = bill.grants.invoice;
    return grant?.operation === 'invoice' && activeGrant(grant, at) && isDeepStrictEqual(grant.scope, bill.bill);
  };

  function requireAccess(permitted, source) {
    if (!permitted) throw new ManualStepError(`Access is needed for ${source}. Follow the participant’s permission choice.`);
  }

  function lookup(source, read) {
    actions.ongoing.push({ action: 'lookup', source });
    return read();
  }

  function consent({ errand, scope, choice }) {
    const target = [...permissionTargets.values()].find(target => target.errand === errand && target.scope === scope);
    if (!target || !['allowed', 'declined'].includes(choice)) throw new ManualStepError('Choose a listed permission and consent action.');
    const record = outcomes[errand];
    const grants = errand === 'refund' ? record.refundAccess : record.grants;
    if (grants[scope]?.status === choice && (choice === 'declined' || activeGrant(grants[scope], clock()))) {
      return { errand, scope, choice, alreadyRecorded: true };
    }
    grants[scope] = errand === 'refund'
      ? refundGrant(mondayRefund, scope, choice, grants[scope], clock())
      : makeGrant(scope, scopes(record)[scope], choice, grants[scope], clock());
    if (scope === 'freeBusy') busy = null;
    if (scope === 'slots') slots = null;
    if (errand === 'visit' && scope !== 'calendar') selected = null;
    if (scope === 'merchant') merchantLinks = [];
    actions.setup.push({ action: 'consent', errand, scope, choice });
    return { errand, scope, choice };
  }

  function showInvoice() {
    requireAccess(canReadInvoice(), 'the electricity invoice');
    const invoice = lookup('electricity-invoice', () => billFixture.readInvoice(bill.bill.invoiceId, canReadInvoice));
    if (!invoice) throw new ManualStepError('The electricity invoice could not be read.');
    bill.invoice = invoice;
    const grant = bill.grants.payment;
    bill.issue = grant?.operation === 'payment' && activeGrant(grant, clock()) &&
      matching(['invoiceId', 'payee', 'currency'], invoice, bill.bill) && matching(['payee', 'currency'], invoice, grant.scope) &&
      invoice.amountMinor > grant.scope.capMinor ? 'bill-review' : null;
    presentBillDecision(actions, bill);
    const fields = ['invoiceId', 'revision', 'payee', 'payeeLabel', 'currency', 'amountMinor'];
    return {
      previous: pick(fields, previousInvoice), current: pick(fields, invoice), capMinor: bill.capMinor,
      decision: bill.issue === 'bill-review' ? 'A new decision is needed for this revision. Payment is beyond this cutoff.' : null
    };
  }

  function showAvailability() {
    requireAccess(canVisit('freeBusy'), 'calendar availability');
    selected = null;
    busy = lookup('calendar-free-busy', () => visitFixture.readFreeBusy(visitWindow, at => canVisit('freeBusy', at)));
    if (!busy) throw new ManualStepError('Calendar availability could not be read.');
    return { window: visitWindow, busy: busy.map(interval => pick(['start', 'end'], interval)) };
  }

  function showSlots() {
    requireAccess(canVisit('slots'), 'provider offers');
    selected = null;
    const offers = lookup('visit-provider-slots', () => visitFixture.readSlots(visitScope, at => canVisit('slots', at)));
    slots = offers?.filter(slot => inScopeOffer(slot, visitScope, +clock()));
    if (!slots) throw new ManualStepError('The provider offers could not be read.');
    return { provider: visitScope.issuer, service: visitScope.service, offers: slots.map(slot => pick(slotTerms, slot)) };
  }

  function shownEligibleSlots() {
    return slots && busy ? slots.filter(slot => inScopeOffer(slot, visitScope, +clock()) && fitsAvailability(slot, busy)) : [];
  }

  function choose(slotId) {
    requireAccess(canVisit('freeBusy') && canVisit('slots') && canVisit('reserve'), 'choosing a free booking');
    if (bookingIntent) throw new ManualStepError('Use look booking for the original reservation.');
    if (!slots || !busy) throw new ManualStepError('Use look availability and look slots before choosing an offer.');
    const slot = shownEligibleSlots().find(candidate => candidate.id === slotId);
    if (!slot) throw new ManualStepError('Choose a displayed free offer within the permitted window and outside busy time.');
    selected = slot;
    actions.ongoing.push({ action: 'choose-slot', slotId: slot.id });
    return { selected: pick([...appointmentFields, ...slotTerms], slot), next: 'Use book with the selected offer ID to submit these terms.' };
  }

  function book(slotId) {
    requireAccess(canVisit('freeBusy') && canVisit('slots') && canVisit('reserve'), 'submitting a free booking');
    if (bookingIntent) throw new ManualStepError('Use look booking for the original reservation.');
    if (!selected || selected.id !== slotId) throw new ManualStepError('Choose the displayed offer before booking it.');
    const terms = selected;
    selected = null;
    actions.ongoing.push({ action: 'submit-booking', slotId: terms.id });
    const result = visitFixture.reserve({ ...visitScope, key: bookingKey, slotId: terms.id, revision: terms.revision },
      fresh => canVisit('freeBusy') && canVisit('slots') && canVisit('reserve') &&
        fresh.slotId === terms.id && matching(bookedTerms, fresh, terms) && zonedInstant(fresh.start) > +clock());
    if (result.status === 'blocked') {
      slots = busy = null;
      return { booking: 'blocked', reason: result.reason, next: 'Look up availability and offers again before choosing.' };
    }
    bookingIntent = terms;
    return { booking: 'submitted', next: 'Use look booking to verify the original reservation.' };
  }

  function showBooking() {
    requireAccess(canVisit('slots'), 'the original provider reservation');
    if (!bookingIntent) throw new ManualStepError('Submit a chosen booking before looking for its receipt.');
    const reservation = lookup('provider-reservation-readback', () =>
      visitFixture.reservationByKey(bookingKey, at => canVisit('slots', at)));
    if (!reservation || reservation.key !== bookingKey || reservation.slotId !== bookingIntent.id ||
        reservation.status !== 'confirmed' || !matching(bookedTerms, reservation, bookingIntent)) {
      return { booking: 'unverified', next: 'Check the original booking again before making another request.' };
    }
    visit.reservation = reservation;
    if (visit.status !== 'verified') visit.status = 'booked';
    return { booking: 'confirmed', reservation: pick(['id', 'slotId', ...bookedTerms], reservation) };
  }

  function addCalendar() {
    requireAccess(canVisit('freeBusy') && canVisit('calendar'), 'adding this visit to the calendar');
    const { reservation } = visit;
    if (!reservation) throw new ManualStepError('Use look booking to verify the original reservation first.');
    if (calendarSubmitted) throw new ManualStepError('Use look calendar for the original calendar entry.');
    actions.ongoing.push({ action: 'submit-calendar', reservationId: reservation.id });
    const added = visitFixture.addToCalendar({ key: calendarKey, reservationId: reservation.id }, fresh =>
      canVisit('freeBusy') && canVisit('calendar') && fresh.reservationId === reservation.id &&
      matching(['slotId', ...bookedTerms], fresh, reservation));
    calendarSubmitted = added.status === 'recorded';
    return { calendar: calendarSubmitted ? 'submitted' : added.status,
      ...(added.interval ? { busy: pick(['start', 'end'], added.interval) } : {}),
      next: calendarSubmitted ? 'Use look calendar to verify this appointment entry.' : 'The booking remains confirmed.' };
  }

  function showCalendar() {
    requireAccess(canVisit('freeBusy') && canVisit('calendar'), 'the appointment calendar entry');
    const { reservation } = visit;
    if (!reservation || !calendarSubmitted) throw new ManualStepError('Verify the booking and submit its calendar entry first.');
    const { calendarEvent, conflict } = lookup('calendar-event-readback', () => ({
      calendarEvent: visitFixture.calendarByReservation(reservation.id, at => canVisit('calendar', at)),
      conflict: visitFixture.calendarConflictForReservation(reservation.id, at => canVisit('freeBusy', at))
    }));
    if (calendarEvent?.reservationId !== reservation.id || !matching(exactTimes, calendarEvent, reservation) || conflict !== null) {
      visit.status = 'booked';
      visit.calendarEvent = null;
      return { calendar: 'unverified', ...(conflict ? { busy: pick(['start', 'end'], conflict) } : {}) };
    }
    visit.status = 'verified';
    visit.calendarEvent = calendarEvent;
    return { calendar: 'verified', event: pick(['id', 'reservationId', ...exactTimes], calendarEvent) };
  }

  function showShop() {
    requireAccess(canRefund('merchant'), 'the shop return thread');
    const read = lookup('merchant-refund-thread', () => refundFixture.readForCheck('merchant',
      refundScope(mondayRefund, 'merchant'), { authorize: at => canRefund('merchant', at) }));
    if (read.status !== 'checked') throw new ManualStepError('The shop return thread could not be read.');
    merchantLinks = read.records.links;
    const events = read.records.events.filter(event => evidenceInstant(event.occurredAt) <= Date.parse(read.checkedAt));
    refund.merchantEvent = latestEvidence(events, 'occurredAt', refund.merchantEvent);
    return { reference: mondayRefund.reference, events: events.map(event => pick(['type', 'occurredAt'], event)) };
  }

  function showCredits() {
    requireAccess(canRefund('credits'), 'incoming credits for this return');
    const linkedCreditIds = canRefund('merchant') ? merchantLinks.map(link => link.creditId) : [];
    const read = lookup('ledger-incoming-credits', () => refundFixture.readForCheck('credits', {
      ...refundScope(mondayRefund, 'credits'), linkedCreditIds
    }, { authorize: at => canRefund('credits', at) && (!linkedCreditIds.length || canRefund('merchant', at)) }));
    if (read.status !== 'checked') throw new ManualStepError('Incoming credits for this return could not be read.');
    const match = matchRefundCredit(mondayRefund, { credits: read.records, links: linkedCreditIds.length ? merchantLinks : [] }, Date.parse(read.checkedAt));
    refund.status = match ? 'verified' : 'open';
    refund.evidence = match ? [match] : [];
    return { refund: refund.status, reference: mondayRefund.reference, match: pick(['id', 'amountMinor', 'currency', 'postedAt'], match) };
  }

  const lookups = new Map([
    ['bill', showInvoice], ['availability', showAvailability], ['slots', showSlots], ['booking', showBooking],
    ['calendar', showCalendar], ['shop', showShop], ['credits', showCredits]
  ]);
  return {
    actions, outcomes, consent, choose, book, addCalendar, shownEligibleSlots,
    look(source) {
      const show = lookups.get(source);
      if (!show) throw new ManualStepError('Choose a listed source to look up.');
      return show();
    }
  };
}

export function scriptedManualMorning(fixtures, warm, actions) {
  const task = createManualMorning(fixtures, warm, actions);
  if (warm) task.look('bill');
  else for (const choice of coldChoices) task.consent(choice);
  task.look('availability');
  if (warm) {
    task.look('slots');
    const offers = task.shownEligibleSlots();
    assert.equal(offers.length, 1);
    task.choose(offers[0].id);
    assert.equal(task.book(offers[0].id).booking, 'submitted');
    assert.equal(task.look('booking').booking, 'confirmed');
    assert.equal(task.addCalendar().calendar, 'submitted');
    assert.equal(task.look('calendar').calendar, 'verified');
    task.look('shop');
    assert.equal(task.look('credits').match, null);
  }
  return task.outcomes;
}
