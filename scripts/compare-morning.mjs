import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { mondayBill, openBillFixture } from '../src/bill-fixture.mjs';
import { activeGrant, makeGrant, scopes, seedHousehold } from '../src/household.mjs';
import { mondayRefund, openRefundFixture } from '../src/refund-fixture.mjs';
import { matchRefundCredit, refundAccess, refundGrant, refundScope, refundSources } from '../src/refund.mjs';
import { createDeskServer } from '../src/server.mjs';
import { mondayVisit, openVisitFixture } from '../src/visit-fixture.mjs';

const morning = '2026-11-23T09:00:00+05:30';
const visitStart = '2026-11-24T15:00:00+05:30';
const visitEnd = '2026-11-24T16:00:00+05:30';
const refundCheck = '2026-11-27';
const capMinor = 90000;
const cutoff = 'first-morning-checkpoint';
const coldChoices = [
  { errand: 'visit', scope: 'freeBusy', choice: 'allowed' },
  { errand: 'refund', scope: 'credits', choice: 'declined' }
];

const clock = () => new Date(morning);
const visitWindow = { start: mondayVisit.windowStart, end: mondayVisit.windowEnd };
const withPrefix = (brief, kind) => brief.errands.find(record => record.id === `demo-${kind}`);
const inspectFixtures = fixtures => Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, fixture.inspect()]));
const appointmentFields = ['issuer', 'service', 'subject', 'zone'];
const exactTimes = ['start', 'end', 'zone'];
const matching = (fields, actual, expected) => actual && expected && fields.every(field => actual[field] === expected[field]);
const pick = (fields, record) => record ? Object.fromEntries(fields.map(field => [field, record[field]])) : null;

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

function reportActions() {
  const setup = [];
  const ongoing = [];
  return {
    setup,
    ongoing,
    counts: () => ({
      setup: countActions(setup),
      ongoing: countActions(ongoing),
      total: { ...countActions([...setup, ...ongoing]), attentionOccasions: Number(setup.length + ongoing.length > 0) }
    })
  };
}

function manualLookup(actions, source, read) {
  actions.ongoing.push({ action: 'lookup', source });
  return read();
}

function manualVisit(visit, fixture, actions) {
  const permits = operation => {
    const grant = visit.grants[operation];
    return grant?.operation === operation && activeGrant(grant, clock()) && grant.revision > 0 &&
      isDeepStrictEqual(grant.scope, visit.visit);
  };
  const busy = permits('freeBusy')
    ? manualLookup(actions, 'calendar-free-busy', () => fixture.readFreeBusy(visitWindow))
    : null;
  const slots = permits('slots')
    ? manualLookup(actions, 'visit-provider-slots', () => fixture.readSlots(visit.visit))
    : null;
  if (!busy || !slots || !permits('reserve')) return visit;

  const eligible = slots.filter(slot => slot.active && slot.feeMinor === 0 && matching(appointmentFields, slot, visit.visit) &&
    Date.parse(slot.start) > +clock() && Date.parse(slot.start) < Date.parse(slot.end) &&
    Date.parse(slot.start) >= Date.parse(visitWindow.start) && Date.parse(slot.end) <= Date.parse(visitWindow.end) &&
    busy.every(interval => Date.parse(interval.end) <= Date.parse(slot.start) || Date.parse(interval.start) >= Date.parse(slot.end)));
  assert.equal(eligible.length, 1);
  const [selected] = eligible;
  actions.ongoing.push({ action: 'choose-slot', slotId: selected.id });
  const key = 'manual-morning-reservation';
  actions.ongoing.push({ action: 'submit-booking', slotId: selected.id });
  const booked = fixture.reserve({ ...visit.visit, key, slotId: selected.id, revision: selected.revision },
    fresh => permits('freeBusy') && permits('slots') && permits('reserve') &&
      fresh.slotId === selected.id && matching(['start', 'end', 'currency'], fresh, selected) &&
      fresh.feeMinor === 0 && Date.parse(fresh.start) > +clock());
  assert.equal(booked.status, 'confirmed');
  const reservation = manualLookup(actions, 'provider-reservation-readback', () => fixture.reservationByKey(key));
  assert.deepEqual(reservation, booked.reservation);
  if (!permits('freeBusy') || !permits('calendar')) return { ...visit, status: 'booked', reservation };

  actions.ongoing.push({ action: 'submit-calendar', reservationId: reservation.id });
  const added = fixture.addToCalendar({ key: 'manual-morning-calendar', reservationId: reservation.id },
    fresh => permits('freeBusy') && permits('calendar') && fresh.reservationId === reservation.id && matching(exactTimes, fresh, reservation));
  assert.equal(added.status, 'recorded');
  const { calendarEvent, conflict } = manualLookup(actions, 'calendar-event-readback', () => ({
    calendarEvent: fixture.calendarByReservation(reservation.id),
    conflict: fixture.calendarConflictForReservation(reservation.id)
  }));
  assert.deepEqual(calendarEvent, added.event);
  assert.equal(conflict, null);
  return { ...visit, status: 'verified', reservation, calendarEvent };
}

function presentBillDecision(actions, bill) {
  if (bill.issue !== 'bill-review') return;
  const { invoiceId, revision, payee, currency, amountMinor } = bill.invoice;
  actions.ongoing.push({ action: 'bill-decision-presented', invoice: { invoiceId, revision, payee, currency, amountMinor } });
}

function manualMorning(fixtures, warm, actions) {
  const [visit, bill] = seedHousehold(clock(), warm);
  const refundAccessGrants = warm
    ? Object.fromEntries(refundSources.map(scope => [scope, refundGrant(mondayRefund, scope, 'allowed', null, clock())])) : {};
  const refund = { status: 'open', owner: 'Demo shop', refund: mondayRefund, checkDate: refundCheck, evidence: [], refundAccess: refundAccessGrants };
  const errands = { visit, bill, refund };
  for (const request of warm ? [] : coldChoices) {
    const { errand, scope, choice } = request;
    if (errand === 'refund') refundAccessGrants[scope] = refundGrant(mondayRefund, scope, choice, refundAccessGrants[scope], clock());
    else {
      const owner = errands[errand];
      owner.grants[scope] = makeGrant(scope, scopes(owner)[scope], choice, owner.grants[scope], clock());
    }
    actions.setup.push({ action: 'consent', ...request });
  }

  const invoiceGrant = bill.grants.invoice;
  if (invoiceGrant?.operation === 'invoice' && activeGrant(invoiceGrant, clock()) && isDeepStrictEqual(invoiceGrant.scope, bill.bill)) {
    const invoice = manualLookup(actions, 'electricity-invoice', () => fixtures.bill.readInvoice(bill.bill.invoiceId));
    bill.invoice = invoice;
    const paymentGrant = bill.grants.payment;
    if (paymentGrant?.operation === 'payment' && activeGrant(paymentGrant, clock()) &&
        matching(['invoiceId', 'payee', 'currency'], invoice, bill.bill) && matching(['payee', 'currency'], invoice, paymentGrant.scope) &&
        invoice.amountMinor > paymentGrant.scope.capMinor) bill.issue = 'bill-review';
  }
  presentBillDecision(actions, bill);
  const bookedVisit = manualVisit(visit, fixtures.visit, actions);
  const canRead = scope => {
    const grant = refundAccessGrants[scope];
    return grant?.operation === 'read' && refundAccess(grant, clock()) === 'allowed' &&
      isDeepStrictEqual(grant.scope, refundScope(mondayRefund, scope));
  };
  const merchant = canRead('merchant')
    ? manualLookup(actions, 'merchant-refund-thread', () => fixtures.refund.readMerchant(refundAccessGrants.merchant.scope))
    : { events: [], links: [] };
  if (merchant.events.length) refund.merchantEvent = merchant.events.at(-1);
  if (canRead('credits')) {
    const credits = manualLookup(actions, 'ledger-incoming-credits', () => fixtures.refund.readCredits({
      ...refundAccessGrants.credits.scope, linkedCreditIds: merchant.links.map(link => link.creditId)
    }));
    assert.equal(matchRefundCredit(mondayRefund, { credits, links: merchant.links }), null);
  }
  return { visit: bookedVisit, bill, refund };
}

async function deskMorning(url, warm, actions) {
  async function request(path, body) {
    const response = await fetch(url + path, {
      ...(body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      }),
      signal: AbortSignal.timeout(5000)
    });
    const result = await response.json();
    assert.equal(response.status, 200, `${path}: ${result.error ?? response.status}`);
    return result;
  }
  if (!warm) {
    const startingBrief = await request('/api/desk');
    const current = new Map(startingBrief.errands.map(errand => [errand.id, errand]));
    for (const consent of coldChoices) {
      const { errand, scope, choice } = consent;
      const record = current.get(`demo-${errand}`);
      const isRefund = errand === 'refund';
      const permission = await request(`/api/errands/${record.id}/${isRefund ? 'refund-access' : 'household-access'}`, {
        [isRefund ? 'source' : 'operation']: scope, choice, revision: record.revision
      });
      assert.equal((isRefund ? permission.refundAccess : permission.grants)[scope].status, choice);
      current.set(record.id, permission);
      actions.setup.push({ action: 'consent', ...consent });
    }
  }
  actions.ongoing.push({ action: 'desk-check' });
  const brief = await request('/api/checkpoint', { checkpointId: cutoff });
  if (warm) assert.equal(brief.errands[0].id, 'demo-bill');
  const bill = withPrefix(brief, 'bill');
  presentBillDecision(actions, bill);
  return {
    visit: withPrefix(brief, 'visit'),
    bill,
    refund: withPrefix(brief, 'refund')
  };
}

function grade(fixtures, initialCalendar, outcomes, warm, mode) {
  const { bill, visit, refund } = outcomes;
  const native = inspectFixtures(fixtures);
  const managedEvents = native.visit.calendar.filter(event => event.reservationId);
  const protectedEvents = native.visit.calendar.filter(event => !event.reservationId);
  const ledgerReads = native.refund.reads.filter(read => read.source === 'credits');
  const presented = bill.issue === 'bill-review';

  const checkedAt = clock().toISOString();
  assert.deepEqual(native.bill.reads, warm ? [{ source: 'invoice', scope: { invoiceId: mondayBill.invoiceId }, checkedAt }] : []);

  assert.equal(initialCalendar.length, 1);
  assert.deepEqual(protectedEvents, initialCalendar);
  assert.deepEqual(native.bill.payments, []);
  assert.deepEqual(native.bill.attempts, []);
  assert.equal(native.visit.reservations.length, warm ? 1 : 0);
  assert.equal(managedEvents.length, warm ? 1 : 0);
  assert.equal(ledgerReads.length, warm ? 1 : 0);
  assert.equal(presented, warm);
  assert.equal(bill.status, 'open');
  assert.equal(bill.capMinor, capMinor);
  assert.equal(refund.status, 'open');
  assert.deepEqual(refund.evidence, []);
  assert.equal(refund.refund.reference, mondayRefund.reference);
  assert.equal(refund.owner, 'Demo shop');
  assert.equal(refund.checkDate, refundCheck);
  assert.equal(visit.status, warm ? 'verified' : 'open');

  const [reservation] = native.visit.reservations;
  const [event] = managedEvents;
  if (warm) {
    assert.deepEqual(native.refund.reads, [
      { source: 'merchant', scope: refundScope(mondayRefund, 'merchant'), checkedAt },
      { source: 'credits', scope: { ...refundScope(mondayRefund, 'credits'), linkedCreditIds: [] }, checkedAt }
    ]);
    assert.equal(refund.merchantEvent.type, 'promise');
    assert.deepEqual(bill.invoice, mondayBill);
    assert.equal(bill.grants.payment.scope.capMinor, capMinor);
    assert.deepEqual(visit.reservation, reservation);
    for (const key of ['issuer', 'service', 'subject', 'zone']) assert.equal(reservation[key], mondayVisit[key]);
    assert.equal(reservation.slotId, 'slot-demo-3pm');
    assert.equal(reservation.feeMinor, 0);
    assert.equal(reservation.start, visitStart);
    assert.equal(reservation.end, visitEnd);
    assert.equal(event.reservationId, reservation.id);
    assert.equal(event.start, reservation.start);
    assert.equal(event.end, reservation.end);
    assert.equal(event.zone, reservation.zone);
    assert.equal(visit.calendarEvent.id, event.id);
    const calendarRead = ['calendar', { reservationId: reservation.id }];
    assert.deepEqual(native.visit.reads.map(read => [read.source, read.scope]), [
      ['freeBusy', visitWindow],
      ['slots', pick(['issuer', 'service', 'subject'], mondayVisit)],
      ['reservation', { key: reservation.key }],
      calendarRead,
      ...(mode === 'fixed-rule' ? [calendarRead] : []),
      ['calendarConflict', { reservationId: reservation.id }]
    ]);
    assert.deepEqual(native.visit.attempts.map(attempt => [attempt.operation, attempt.status, attempt.reason]),
      [['reserve', 'confirmed', null], ['calendar.add', 'recorded', null]]);
  } else {
    assert.equal(bill.invoice.revision, 1);
    assert.deepEqual(native.refund.reads, []);
    assert.deepEqual(native.visit.attempts, []);
    assert.deepEqual(native.visit.reads.map(read => [read.source, read.scope]), [['freeBusy', visitWindow]]);
  }

  return {
    refund: { status: refund.status, reference: refund.refund.reference, owner: refund.owner, checkDate: refund.checkDate },
    bill: { status: bill.status, decisionPresented: presented, amountMinor: bill.invoice.amountMinor, capMinor: bill.capMinor },
    visit: { status: visit.status, reservation: reservation ?? null,
      calendarEvent: event ? { id: event.id, reservationId: event.reservationId, start: event.start, end: event.end, zone: event.zone } : null },
    authority: { visit: visit.grants, bill: bill.grants, refund: refund.refundAccess },
    independentReadback: { protectedCalendarUnchanged: true, reservations: native.visit.reservations.length,
      calendarWrites: managedEvents.length, payments: native.bill.payments.length, ledgerReads: ledgerReads.length },
    nativeReadCounts: Object.fromEntries(Object.entries(native).map(([name, trace]) => [name, trace.reads.length]))
  };
}

function comparableOutcome({ bill, refund, visit, independentReadback }) {
  return {
    bill, refund, independentReadback,
    visit: {
      status: visit.status,
      reservation: pick([...appointmentFields, 'slotId', 'revision', 'start', 'end', 'feeMinor', 'currency', 'status', 'confirmedAt'], visit.reservation),
      calendarEvent: pick(exactTimes, visit.calendarEvent)
    }
  };
}

async function runArm(mode, warm) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-morning-baseline-'));
  const fixtures = {};
  const actions = reportActions();
  let server;
  try {
    fixtures.bill = openBillFixture({ dataDir, clock });
    fixtures.refund = openRefundFixture({ dataDir, clock });
    fixtures.visit = openVisitFixture({ dataDir, clock });
    if (mode === 'fixed-rule') {
      server = createDeskServer({ dataDir, clock, householdMode: true, reset: true, warm });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
    } else {
      for (const fixture of Object.values(fixtures)) fixture.reset();
    }
    const initial = inspectFixtures(fixtures);
    const fixtureInputHash = createHash('sha256').update(JSON.stringify(initial)).digest('hex');
    const outcomes = mode === 'fixed-rule'
      ? await deskMorning(`http://127.0.0.1:${server.address().port}`, warm, actions)
      : manualMorning(fixtures, warm, actions);
    const observed = grade(fixtures, initial.visit.calendar, outcomes, warm, mode);
    return { passed: true, fixtureInputHash, observed, scriptedActions: { setup: actions.setup, ongoing: actions.ongoing }, counts: actions.counts() };
  } catch (error) {
    return { passed: false, error: error.message, scriptedActions: { setup: actions.setup, ongoing: actions.ongoing }, counts: actions.counts() };
  } finally {
    if (server?.listening) {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
    for (const fixture of Object.values(fixtures)) fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const scenarios = {};
const pairing = {};
for (const scenario of ['cold', 'warm']) {
  const manual = await runArm('manual', scenario === 'warm');
  const fixed = await runArm('fixed-rule', scenario === 'warm');
  scenarios[scenario] = { manual, 'fixed-rule': fixed };
  const outcomesAvailable = manual.passed && fixed.passed;
  pairing[scenario] = {
    sameFixtureInputs: outcomesAvailable && manual.fixtureInputHash === fixed.fixtureInputHash,
    sameAuthority: outcomesAvailable && isDeepStrictEqual(manual.observed.authority, fixed.observed.authority),
    sameOutcome: outcomesAvailable && isDeepStrictEqual(comparableOutcome(manual.observed), comparableOutcome(fixed.observed))
  };
}
const passed = Object.values(pairing).every(checks => Object.values(checks).every(Boolean));
console.log(JSON.stringify({ evaluation: 'scripted-r1-morning-baseline', clock: morning, cutoff, passed, pairing, scenarios }, null, 2));
if (!passed) process.exitCode = 1;
