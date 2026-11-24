import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evidenceInstant, zonedInstant } from '../shared/evidence-time.mjs';
import { mondayBill, openBillFixture } from '../src/bill-fixture.mjs';
import { sameInvoice } from '../src/household.mjs';
import { openOutboxFixture } from '../src/outbox-fixture.mjs';
import { openReceiptFixture, practiceReceiptSource, receiptIdentifier } from '../src/receipt-fixture.mjs';
import { mondayRefund, openRefundFixture } from '../src/refund-fixture.mjs';
import { refundSources } from '../src/refund.mjs';
import { mondayVisit, openVisitFixture } from '../src/visit-fixture.mjs';

const dataDir = resolve(process.env.RELAY_DATA_DIR ?? '.relay/demo');
const clock = new Date(zonedInstant(process.env.RELAY_CLOCK ?? '2026-11-23T09:00:00+05:30'));
const actions = new Map([
  ['unrelated-credit', [() => postCredit(false)]],
  ['matching-credit', [() => postCredit(true)]],
  ['refund-unlinked-credit', [postUnlinkedCredit, 'CREDIT_LABEL']],
  ['refund-link-credit', [linkRefundCredit, 'CREDIT_LABEL', 'merchant|unrelated']],
  ['refund-offline', [source => refundAvailability(source, false), 'merchant|credits']],
  ['refund-online', [source => refundAvailability(source, true), 'merchant|credits']],
  ['settle-bill', [settleBill]],
  ['bill-revision', [reviseBill, 'REVISION', 'AMOUNT_MINOR', 'CURRENCY', 'PAYEE']],
  ['lose-next-reply', [loseReply, 'payment|reservation|calendar|outbox']],
  ['fail-next-calendar-write', [failCalendarWrite]],
  ['visit-slot', [publishVisitSlot, 'SLOT_ID', 'ISSUER', 'SERVICE', 'SUBJECT', 'START', 'END', 'FEE_MINOR']],
  ['visit-slot-withdraw', [withdrawVisitSlot, 'SLOT_ID']],
  ['calendar-commitment', [publishCommitment, 'EVENT_ID', 'START', 'END', 'TITLE']],
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

function withRefundCredit(label, publish) {
  const id = `demo-unlinked-refund-${receiptIdentifier(label, 'a synthetic credit label')}`;
  const { account, amountMinor, currency } = mondayRefund;
  const terms = { id, account, amountMinor, currency, direction: 'incoming', status: 'posted', returnReference: null };
  return withFixture(openRefundFixture, 'refund-fixture.sqlite', fixture => fixture.withinSnapshot(() => {
    const previous = fixture.inspect().credits.find(credit => credit.id === id);
    if (previous && (!Object.entries(terms).every(([field, value]) => previous[field] === value) ||
        !Number.isFinite(evidenceInstant(previous.postedAt)))) {
      throw new Error('That credit label already belongs to a different practice record.');
    }
    return publish(fixture, previous, terms);
  }));
}

function postUnlinkedCredit(label) {
  return withRefundCredit(label, (fixture, previous, terms) => {
    if (previous) return previous;
    const credit = { ...terms, postedAt: clock.toISOString() };
    fixture.putCredit(credit);
    return credit;
  });
}

function linkRefundCredit(label, kind) {
  if (kind !== 'merchant' && kind !== 'unrelated') throw new Error('Choose merchant or unrelated for the practice link issuer.');
  return withRefundCredit(label, (fixture, credit) => {
    if (!credit) throw new Error('Publish the unlinked practice credit first.');
    const { merchantIssuer, thread, reference } = mondayRefund;
    return fixture.putLink({
      issuer: kind === 'merchant' ? merchantIssuer : 'merchant-demo-unrelated',
      thread, returnReference: reference, creditId: credit.id, issuedAt: clock.toISOString()
    });
  });
}

function refundAvailability(source, available) {
  if (!refundSources.includes(source)) throw new Error('Choose merchant or credits for the practice refund source.');
  return withFixture(openRefundFixture, 'refund-fixture.sqlite', fixture => {
    fixture.setAvailable(source, available);
    return { source, available };
  });
}

function reviseBill(revisionText, amountText, currency, payee) {
  const revision = Number(revisionText);
  const amountMinor = Number(amountText);
  if (![revisionText, amountText].every(value => /^[1-9]\d*$/u.test(value)) ||
      ![revision, amountMinor].every(Number.isSafeInteger) || !/^[A-Z]{3}$/u.test(currency)) {
    throw new Error('Use a positive integer revision and minor-unit amount, with a three-letter uppercase currency.');
  }
  const terms = { ...mondayBill, revision, amountMinor, currency, payee: receiptIdentifier(payee, 'a payee identifier') };
  return withFixture(openBillFixture, 'providers.sqlite', fixture => fixture.publishRevision(terms));
}

function loseReply(operation) {
  const faults = new Map([
    ['payment', [openBillFixture, 'failNextReply']],
    ['reservation', [openVisitFixture, 'failNextReservationReply']],
    ['calendar', [openVisitFixture, 'failNextCalendarReply']],
    ['outbox', [openOutboxFixture, 'failNextReply']]
  ]);
  if (!faults.has(operation)) throw new Error('Choose payment, reservation, calendar, or outbox for the next lost reply.');
  const [open, method] = faults.get(operation);
  return withFixture(open, 'providers.sqlite', fixture => {
    fixture[method]();
    return { operation, nextReply: 'will-be-lost' };
  });
}

function failCalendarWrite() {
  return withFixture(openVisitFixture, 'providers.sqlite', fixture => {
    fixture.failNextCalendarWrite();
    return { operation: 'calendar', nextWrite: 'will-fail' };
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

function interval(start, end) {
  if (!(evidenceInstant(start) < evidenceInstant(end))) {
    throw new Error('Use an ordered start and end with ISO seconds and an explicit time-zone offset.');
  }
  return { start, end };
}

function publishVisitSlot(slotId, issuer, service, subject, start, end, fee) {
  const id = receiptIdentifier(slotId, 'a slot identifier');
  const identity = {
    issuer: receiptIdentifier(issuer, 'a provider identifier'),
    service: receiptIdentifier(service, 'a service identifier'),
    subject: receiptIdentifier(subject, 'a subject reference')
  };
  const feeMinor = Number(fee);
  if (!/^\d+$/u.test(fee) || !Number.isSafeInteger(feeMinor)) throw new Error('Give the slot fee in whole paise. Use 0 for a free offer.');
  const offer = { id, ...identity, ...interval(start, end), zone: mondayVisit.zone, active: true, feeMinor, currency: 'INR' };
  return withFixture(openVisitFixture, 'providers.sqlite', fixture => {
    const previous = fixture.inspect().slots.find(slot => slot.id === id);
    if (previous && Object.entries(identity).some(([field, value]) => previous[field] !== value)) {
      throw new Error('Use a new slot identifier for a different provider, service or subject.');
    }
    if (previous && Object.entries(offer).every(([field, value]) => previous[field] === value)) return previous;
    return fixture.putSlot({ ...offer, revision: (previous?.revision ?? 0) + 1 });
  });
}

function withdrawVisitSlot(slotId) {
  const id = receiptIdentifier(slotId, 'a slot identifier');
  return withFixture(openVisitFixture, 'providers.sqlite', fixture => {
    const slot = fixture.inspect().slots.find(item => item.id === id);
    if (!slot) throw new Error('Publish the practice slot before withdrawing it.');
    return slot.active ? fixture.putSlot({ ...slot, active: false, revision: slot.revision + 1 }) : slot;
  });
}

function publishCommitment(eventId, start, end, title) {
  const id = receiptIdentifier(eventId, 'a calendar event identifier');
  if (!title.trim()) throw new Error('Give the synthetic commitment a title.');
  const event = { id, ...interval(start, end), title: title.trim() };
  return withFixture(openVisitFixture, 'providers.sqlite', fixture => fixture.putCalendarEvent(event));
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
    const end = zonedInstant(booking.end);
    const duration = end - zonedInstant(booking.start);
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
  if (!Number.isFinite(+clock)) throw new Error('Set RELAY_CLOCK to a valid ISO timestamp with an explicit offset.');
  console.log(JSON.stringify(publish(...extra), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
