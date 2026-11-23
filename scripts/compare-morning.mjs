import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mondayBill, openBillFixture } from '../src/bill-fixture.mjs';
import { activeGrant, makeGrant, seedHousehold } from '../src/household.mjs';
import { mondayRefund, openRefundFixture } from '../src/refund-fixture.mjs';
import { matchRefundCredit, refundAccess, refundGrant, refundScope } from '../src/refund.mjs';
import { createDeskServer } from '../src/server.mjs';
import { mondayVisit, openVisitFixture } from '../src/visit-fixture.mjs';

const morning = '2026-11-23T09:00:00+05:30';
const visitStart = '2026-11-24T15:00:00+05:30';
const visitEnd = '2026-11-24T16:00:00+05:30';
const refundCheck = '2026-11-27';
const capMinor = 90000;
const coldChoices = [
  { errand: 'visit', scope: 'freeBusy', choice: 'allowed' },
  { errand: 'refund', scope: 'credits', choice: 'declined' }
];

const clock = () => new Date(morning);
const visitWindow = { start: mondayVisit.windowStart, end: mondayVisit.windowEnd };
const withPrefix = (brief, kind) => brief.errands.find(record => record.id === `demo-${kind}`);

function reportActions(warm) {
  const setup = warm ? [] : coldChoices.map(choice => ({ action: 'consent', ...choice }));
  const ongoing = [];
  return {
    setup,
    ongoing,
    counts: () => ({
      setup: { consentChoices: setup.length },
      ongoing: {
        humanLookups: ongoing.filter(action => action.action === 'lookup').length,
        slotChoices: ongoing.filter(action => action.action === 'choose-slot').length,
        checkClicks: ongoing.filter(action => action.action === 'desk-check').length,
        bookingSubmissions: ongoing.filter(action => action.action === 'submit-booking').length,
        calendarSubmissions: ongoing.filter(action => action.action === 'submit-calendar').length,
        billDecisionsPresented: ongoing.filter(action => action.action === 'bill-decision-presented').length,
        billDecisionsTaken: ongoing.filter(action => action.action === 'bill-decision-taken').length
      }
    })
  };
}

function manualLookup(actions, source, read) {
  actions.ongoing.push({ action: 'lookup', source });
  return read();
}

function manualVisit(visit, fixture, actions) {
  const permits = operation => activeGrant(visit.grants[operation], clock());
  const busy = permits('freeBusy')
    ? manualLookup(actions, 'calendar-free-busy', () => fixture.readFreeBusy(visitWindow))
    : [];
  if (!permits('slots')) return visit;

  const slots = manualLookup(actions, 'visit-provider-slots', () => fixture.readSlots(visit.visit));
  const eligible = slots.filter(slot => slot.active && slot.feeMinor === 0 &&
    Date.parse(slot.start) >= Date.parse(visitWindow.start) && Date.parse(slot.end) <= Date.parse(visitWindow.end) &&
    busy.every(interval => Date.parse(interval.end) <= Date.parse(slot.start) || Date.parse(interval.start) >= Date.parse(slot.end)));
  assert.equal(eligible.length, 1);
  const [selected] = eligible;
  actions.ongoing.push({ action: 'choose-slot', slotId: selected.id });
  const key = 'manual-morning-reservation';
  actions.ongoing.push({ action: 'submit-booking', slotId: selected.id });
  const booked = fixture.reserve({ ...visit.visit, key, slotId: selected.id, revision: selected.revision },
    fresh => permits('freeBusy') && permits('slots') && permits('reserve') &&
      fresh.slotId === selected.id && fresh.start === selected.start && fresh.end === selected.end && fresh.feeMinor === 0);
  assert.equal(booked.status, 'confirmed');
  const reservation = manualLookup(actions, 'provider-reservation-readback', () => fixture.reservationByKey(key));
  assert.deepEqual(reservation, booked.reservation);

  actions.ongoing.push({ action: 'submit-calendar', reservationId: reservation.id });
  const added = fixture.addToCalendar({ key: 'manual-morning-calendar', reservationId: reservation.id },
    fresh => permits('calendar') && fresh.reservationId === reservation.id);
  assert.equal(added.status, 'recorded');
  const calendarEvent = manualLookup(actions, 'calendar-event-readback', () => fixture.calendarByReservation(reservation.id));
  assert.deepEqual(calendarEvent, added.event);
  return { ...visit, status: 'verified', reservation, calendarEvent };
}

function manualMorning(fixtures, warm, actions) {
  const [visit, bill] = seedHousehold(clock(), warm);
  if (!warm) visit.grants.freeBusy = makeGrant('freeBusy', mondayVisit, 'allowed', null, clock());
  const creditGrant = refundGrant(mondayRefund, 'credits', warm ? 'allowed' : 'declined', null, clock());
  const merchantGrant = warm ? refundGrant(mondayRefund, 'merchant', 'allowed', null, clock()) : null;
  const refund = { status: 'open', owner: 'Demo shop', refund: mondayRefund, checkDate: refundCheck, evidence: [] };

  if (activeGrant(bill.grants.invoice, clock())) {
    const invoice = manualLookup(actions, 'electricity-invoice', () => fixtures.bill.readInvoice(bill.bill.invoiceId));
    bill.invoice = invoice;
    if (invoice.amountMinor > bill.capMinor) bill.issue = 'bill-review';
  }
  const bookedVisit = manualVisit(visit, fixtures.visit, actions);
  const merchant = refundAccess(merchantGrant, clock()) === 'allowed'
    ? manualLookup(actions, 'merchant-refund-thread', () => fixtures.refund.readMerchant(merchantGrant.scope))
    : { events: [], links: [] };
  if (merchant.events.length) refund.merchantEvent = merchant.events.at(-1);
  if (refundAccess(creditGrant, clock()) === 'allowed') {
    const credits = manualLookup(actions, 'ledger-incoming-credits', () => fixtures.refund.readCredits({
      ...creditGrant.scope, linkedCreditIds: merchant.links.map(link => link.creditId)
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
    for (const { errand, scope, choice } of actions.setup) {
      const record = withPrefix(startingBrief, errand);
      const isRefund = errand === 'refund';
      const permission = await request(`/api/errands/${record.id}/${isRefund ? 'refund-access' : 'household-access'}`, {
        [isRefund ? 'source' : 'operation']: scope, choice, revision: record.revision
      });
      assert.equal((isRefund ? permission.refundAccess : permission.grants)[scope].status, choice);
    }
  }
  actions.ongoing.push({ action: 'desk-check' });
  const brief = await request('/api/checkpoint', { checkpointId: 'manual-baseline-morning' });
  if (warm) assert.equal(brief.errands[0].id, 'demo-bill');
  return {
    visit: withPrefix(brief, 'visit'),
    bill: withPrefix(brief, 'bill'),
    refund: withPrefix(brief, 'refund')
  };
}

function grade(fixtures, initialCalendar, outcomes, warm, actions) {
  const { bill, visit, refund } = outcomes;
  const native = Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, fixture.inspect()]));
  const managedEvents = native.visit.calendar.filter(event => event.reservationId);
  const protectedEvents = native.visit.calendar.filter(event => !event.reservationId);
  const ledgerReads = native.refund.reads.filter(read => read.source === 'credits');
  const presented = bill.issue === 'bill-review';
  if (presented) actions.ongoing.push({ action: 'bill-decision-presented', invoiceId: bill.invoice.invoiceId });

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
    const checkedAt = clock().toISOString();
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
    independentReadback: { protectedCalendarUnchanged: true, reservations: native.visit.reservations.length,
      calendarWrites: managedEvents.length, payments: native.bill.payments.length, ledgerReads: ledgerReads.length }
  };
}

async function runArm(mode, warm) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-morning-baseline-'));
  const fixtures = {};
  const actions = reportActions(warm);
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
    const { calendar } = fixtures.visit.inspect();
    const outcomes = mode === 'fixed-rule'
      ? await deskMorning(`http://127.0.0.1:${server.address().port}`, warm, actions)
      : manualMorning(fixtures, warm, actions);
    const observed = grade(fixtures, calendar, outcomes, warm, actions);
    return { passed: true, observed, scriptedActions: { setup: actions.setup, ongoing: actions.ongoing }, counts: actions.counts() };
  } catch (error) {
    return { passed: false, error: error.message, scriptedActions: { setup: actions.setup, ongoing: actions.ongoing } };
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
for (const scenario of ['cold', 'warm']) {
  scenarios[scenario] = {
    manual: await runArm('manual', scenario === 'warm'),
    'fixed-rule': await runArm('fixed-rule', scenario === 'warm')
  };
}
const passed = Object.values(scenarios).every(arms => Object.values(arms).every(arm => arm.passed));
console.log(JSON.stringify({ evaluation: 'scripted-r1-morning-baseline', clock: morning, passed, scenarios }, null, 2));
if (!passed) process.exitCode = 1;
