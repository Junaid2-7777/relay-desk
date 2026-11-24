import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mondayBill, openBillFixture } from '../src/bill-fixture.mjs';
import { sameInvoice } from '../src/household.mjs';
import { openReceiptFixture, practiceReceiptSource } from '../src/receipt-fixture.mjs';
import { mondayRefund, openRefundFixture } from '../src/refund-fixture.mjs';

const dataDir = resolve(process.env.RELAY_DATA_DIR ?? '.relay/demo');
const clock = new Date(process.env.RELAY_CLOCK ?? '2026-11-23T09:00:00+05:30');
const actions = new Map([
  ['unrelated-credit', () => postCredit(false)],
  ['matching-credit', () => postCredit(true)],
  ['settle-bill', settleBill],
  ['membership-acknowledged', () => postMembership(false)],
  ['membership-closed', () => postMembership(true)]
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
      sameInvoice(row, payment) && Date.parse(row.settledAt) >= Date.parse(payment.acceptedAt));
    if (existing) return existing;
    const { paymentRef, invoiceId, revision, payee, amountMinor, currency } = payment;
    const settlement = {
      paymentRef, invoiceId, revision, payee, amountMinor, currency, status: 'settled', settledAt: clock.toISOString()
    };
    fixture.putSettlement(settlement);
    return settlement;
  });
}

function postMembership(closed) {
  const receipt = {
    id: closed ? 'demo-library-closure' : 'demo-library-acknowledgement',
    issuer: practiceReceiptSource.issuer, subject: 'member-17',
    type: closed ? 'receipt' : 'acknowledgement', status: closed ? 'closed' : 'received', occurredAt: clock.toISOString()
  };
  return withFixture(openReceiptFixture, 'providers.sqlite', fixture => {
    if (!fixture.sources().some(source => source.issuer === receipt.issuer)) {
      throw new Error('Reset the practice household to register the library fixture.');
    }
    fixture.putReceipt(receipt);
    return receipt;
  });
}

const [choice, ...extra] = process.argv.slice(2);
try {
  if (!actions.has(choice) || extra.length) throw new Error(`Choose one practice event (${[...actions.keys()].join(', ')}).`);
  if (!Number.isFinite(+clock)) throw new Error('Set RELAY_CLOCK to the ISO timestamp used by the practice desk.');
  console.log(JSON.stringify(actions.get(choice)(), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
