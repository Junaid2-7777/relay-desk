import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evidenceInstant } from '../shared/evidence-time.mjs';
import { mondayBill, openBillFixture } from '../src/bill-fixture.mjs';
import { sameInvoice } from '../src/household.mjs';
import { openReceiptFixture, practiceReceiptSource } from '../src/receipt-fixture.mjs';
import { mondayRefund, openRefundFixture } from '../src/refund-fixture.mjs';
import { mondayVisit, openVisitFixture } from '../src/visit-fixture.mjs';

const dataDir = resolve(process.env.RELAY_DATA_DIR ?? '.relay/demo');
const clock = new Date(process.env.RELAY_CLOCK ?? '2026-11-23T09:00:00+05:30');
const actions = new Map([
  ['unrelated-credit', [() => postCredit(false)]],
  ['matching-credit', [() => postCredit(true)]],
  ['settle-bill', [settleBill]],
  ['visit-conflict', [() => publishVisitConflict(false)]],
  ['visit-conflict-moved', [() => publishVisitConflict(true)]],
  ['membership-acknowledged', [() => postMembership(false)]],
  ['membership-closed', [() => postMembership(true)]],
  ['receipt-source', [registerIssuer, 'ISSUER', 'LABEL']],
  ['receipt-record', [publishReceipt, 'ISSUER', 'SUBJECT', 'TYPE', 'STATUS', 'RECEIPT_ID']],
  ['receipt-offline', [issuer => issuerAvailability(issuer, false), 'ISSUER']],
  ['receipt-online', [issuer => issuerAvailability(issuer, true), 'ISSUER']]
]);

function withFixture(open, tableFile, write) {
  if (!existsSync(join(dataDir, tableFile))) throw new Error('Start the practice household and use its data directory.');
  const fixture = open({ dataDir });
  try {
    return write(fixture);
  } finally {
    fixture.close();
  }
}

function postCredit(matches) {
  const { account, amountMinor, currency, reference } = mondayRefund;
  const credit = {
    id: matches ? 'demo-posted-refund' : 'demo-posted-other-return',
    account, amountMinor, currency, direction: 'incoming', status: 'posted',
    returnReference: matches ? reference : 'another-practice-return', postedAt: clock.toISOString()
  };
  return withFixture(openRefundFixture, 'refund-fixture.sqlite', fixture => {
    fixture.putCredit(credit);
    return credit;
  });
}

function settleBill() {
  return withFixture(openBillFixture, 'providers.sqlite', fixture => {
    const { payments, settlements } = fixture.inspect();
    const payment = payments.find(row => row.invoiceId === mondayBill.invoiceId);
    if (!payment) throw new Error('No practice payment has been accepted for the electricity bill.');
    if (clock < new Date(payment.acceptedAt)) throw new Error('Set RELAY_CLOCK to the practice clock at or after payment.');
    const existing = settlements.find(row => row.paymentRef === payment.paymentRef && row.status === 'settled' &&
      sameInvoice(row, payment) && evidenceInstant(row.settledAt) >= evidenceInstant(payment.acceptedAt));
    if (existing) return existing;
    const { paymentRef, invoiceId, revision, payee, amountMinor, currency } = payment;
    const settlement = {
      paymentRef, invoiceId, revision, payee, amountMinor, currency, status: 'settled', settledAt: clock.toISOString()
    };
    fixture.putSettlement(settlement);
    return settlement;
  });
}

function publishVisitConflict(moved) {
  return withFixture(openVisitFixture, 'providers.sqlite', fixture => {
    const { calendar, reservations } = fixture.inspect();
    const matches = reservations.filter(row => row.issuer === mondayVisit.issuer &&
      row.service === mondayVisit.service && row.subject === mondayVisit.subject && row.status === 'confirmed');
    if (matches.length !== 1) throw new Error('Confirm the practice broadband visit first.');
    const [booking] = matches;
    const id = `practice-overlap-${booking.id}`;
    const previous = calendar.find(event => event.id === id);
    if (moved && !previous) throw new Error('Publish visit-conflict before moving the practice commitment.');
    if (!moved && calendar.some(event => event.reservationId === booking.id)) {
      throw new Error('Use a cold practice desk and withhold calendar entry access until the overlap has been published.');
    }
    const end = evidenceInstant(booking.end);
    const duration = end - evidenceInstant(booking.start);
    return fixture.putCalendarEvent({
      id, title: 'Practice calendar owner commitment',
      start: moved ? booking.end : booking.start,
      end: moved ? new Date(end + duration).toISOString() : booking.end
    });
  });
}

function postMembership(closed) {
  return publishReceipt(practiceReceiptSource.issuer, 'member-17',
    closed ? 'receipt' : 'acknowledgement', closed ? 'closed' : 'received',
    closed ? 'demo-library-closure' : 'demo-library-acknowledgement');
}

function registerIssuer(issuer, label) {
  return withFixture(openReceiptFixture, 'providers.sqlite', fixture => fixture.putSource({ issuer, label }));
}

function publishReceipt(issuer, subject, type, status, id) {
  return withFixture(openReceiptFixture, 'providers.sqlite', fixture =>
    fixture.putReceipt({ issuer, subject, type, status, id, occurredAt: clock.toISOString() }));
}

function issuerAvailability(issuer, available) {
  return withFixture(openReceiptFixture, 'providers.sqlite', fixture => fixture.setAvailable(issuer, available));
}

const [choice, ...extra] = process.argv.slice(2);
try {
  if (!actions.has(choice)) throw new Error(`Choose one practice event (${[...actions.keys()].join(', ')}).`);
  const [publish, ...parameters] = actions.get(choice);
  if (extra.length !== parameters.length) throw new Error(`Use: npm run demo:evidence -- ${[choice, ...parameters].join(' ')}`);
  if (!Number.isFinite(+clock)) throw new Error('Set RELAY_CLOCK to the ISO timestamp used by the practice desk.');
  console.log(JSON.stringify(publish(...extra), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
