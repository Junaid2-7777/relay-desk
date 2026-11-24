import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openActionJournal } from '../src/action-journal.mjs';
import { mondayBill, openBillFixture } from '../src/bill-fixture.mjs';
import { runBill } from '../src/bill.mjs';
import { seedHousehold } from '../src/household.mjs';

const now = new Date('2026-11-23T05:30:00Z');
const later = '2026-11-24T05:30:00.000Z';

function setup(t, { seedInvoices = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-bill-flow-'));
  let time = now;
  const fixture = openBillFixture({ dataDir, clock: () => time });
  const db = new DatabaseSync(':memory:');
  t.after(() => {
    fixture.close();
    db.close();
    rmSync(dataDir, { force: true, recursive: true });
  });
  if (seedInvoices) fixture.reset();
  let record = seedHousehold(now, true).find(item => item.kind === 'bill');
  const journal = openActionJournal(db, () => record, action => action(), () => time);
  return {
    fixture,
    journal,
    moveTime(value) { time = value; },
    get record() { return record; },
    update(patch) { record = { ...record, ...patch }; },
    check(provider = fixture, operations = journal) {
      record = runBill(record, provider, operations, time);
      return record;
    }
  };
}

function approve(record) {
  return { ...record.invoice, status: 'allowed', expiresAt: later, grantRevision: record.grants.payment.revision };
}

test('the original eligible invoice is paid under the standing permission', t => {
  const desk = setup(t, { seedInvoices: false });
  desk.fixture.putInvoice({ ...mondayBill, revision: 1, amountMinor: 85000 });

  const accepted = desk.check();
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.issue, 'payment-pending');
  assert.equal(accepted.approval, null);
  assert.equal(accepted.grants.payment.scope.capMinor, 90000);
  assert.equal(accepted.payment.amountMinor, 85000);
  assert.deepEqual(desk.fixture.inspect().payments, [accepted.payment]);
  assert.deepEqual(desk.fixture.inspect().settlements, []);
});

test('the revised bill requires an exact exception and only matching settlement closes it', t => {
  const desk = setup(t);
  const first = desk.check();
  assert.equal(first.issue, 'bill-review');
  assert.deepEqual(first.invoice, mondayBill);
  assert.equal(first.previousInvoice.amountMinor, 85000);
  assert.equal(desk.fixture.inspect().payments.length, 0);

  desk.update({ approval: approve(first) });
  const accepted = desk.check();
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.issue, 'payment-pending');
  assert.equal(accepted.approval.status, 'consumed');
  assert.equal(accepted.grants.payment.scope.capMinor, 90000);

  const { paymentRef, invoiceId, revision, payee, amountMinor, currency } = accepted.payment;
  const receipt = { paymentRef, invoiceId, revision, payee, amountMinor, currency, status: 'settled', settledAt: later };
  desk.fixture.putSettlement({ ...receipt, payee: 'wrong-payee' });
  assert.equal(desk.check().status, 'accepted');
  desk.fixture.putSettlement(receipt);
  assert.deepEqual(desk.check().settlement, receipt);
  assert.equal(desk.record.status, 'verified');
  assert.equal(desk.fixture.inspect().payments.length, 1);
});

test('deferral is exact, and changes or expiration retire an unspent exception', t => {
  const desk = setup(t);
  const first = desk.check();
  desk.update({ deferred: first.invoice });
  assert.equal(desk.check().issue, 'bill-deferred');
  desk.update({ deferred: null, approval: { ...approve(first), expiresAt: now.toISOString() } });
  assert.equal(desk.check().issue, 'bill-review');
  assert.equal(desk.record.approval, null);
  desk.update({ approval: approve(first) });
  desk.fixture.putInvoice({ ...first.invoice, revision: 3, amountMinor: 120000 });
  assert.equal(desk.check().issue, 'bill-review');
  assert.equal(desk.record.approval, null);
  assert.equal(desk.fixture.inspect().payments.length, 0);
});

test('a lost response stays unknown without read access and recovers after access returns', t => {
  const desk = setup(t);
  const first = desk.check();
  desk.update({ approval: approve(first) });
  desk.fixture.failNextReply();
  assert.equal(desk.check().issue, 'payment-unknown');
  const original = desk.journal.latest(first.id, 'pay');
  assert.equal(original.status, 'unknown');
  assert.equal(desk.fixture.inspect().payments.length, 1);

  const { invoice, payment } = desk.record.grants;
  desk.update({ grants: { invoice: { ...invoice, status: 'withdrawn' }, payment: { ...payment, status: 'withdrawn' } } });
  const blockedRead = { paymentByKey: () => assert.fail('revoked readback scope') };
  assert.equal(desk.check(blockedRead).issue, 'payment-unknown');

  desk.update({ grants: { ...desk.record.grants, invoice: { ...invoice, revision: invoice.revision + 1 } } });
  assert.equal(desk.check().status, 'accepted');
  assert.equal(desk.record.payment.key, original.key);
  assert.equal(desk.fixture.inspect().payments.length, 1);
});

test('revocation after journalling strikes before the provider write', t => {
  const desk = setup(t);
  const first = desk.check();
  desk.update({ approval: approve(first) });
  const journal = {
    ...desk.journal,
    prepare(...args) {
      const entry = desk.journal.prepare(...args);
      const { payment } = desk.record.grants;
      desk.update({ grants: { ...desk.record.grants, payment: { ...payment, status: 'withdrawn', revision: payment.revision + 1 } } });
      return entry;
    }
  };
  assert.equal(desk.check(desk.fixture, journal).issue, 'bill-permission');
  assert.deepEqual(desk.fixture.inspect().attempts, []);
});

test('a one-time approval that expires before the provider commits cannot debit the bill', t => {
  const desk = setup(t);
  const invoice = desk.check();
  const expiresAt = '2026-11-23T05:31:00.000Z';
  desk.update({ approval: { ...approve(invoice), expiresAt } });
  const blocked = desk.check({
    ...desk.fixture,
    pay(...args) {
      desk.moveTime(new Date(expiresAt));
      return desk.fixture.pay(...args);
    }
  });

  const { payments, attempts } = desk.fixture.inspect();
  assert.equal(blocked.approval, null);
  assert.deepEqual(payments, []);
  assert.deepEqual(attempts.map(({ status, code }) => [status, code]), [['blocked', 'not-authorized']]);
});

test('a stale checkpoint cannot dispatch a retired payment after a new invoice is paid', t => {
  const desk = setup(t, { seedInvoices: false });
  const original = { ...mondayBill, revision: 1, amountMinor: 85000 };
  const replacement = { ...mondayBill, revision: 2, amountMinor: 87000 };
  desk.fixture.putInvoice(original);
  let latest;
  const stale = {
    ...desk.journal,
    prepare(...args) {
      const entry = desk.journal.prepare(...args);
      desk.fixture.putInvoice(replacement);
      latest = runBill(desk.record, desk.fixture, desk.journal, now);
      return entry;
    }
  };

  desk.check(desk.fixture, stale);
  const { attempts, payments } = desk.fixture.inspect();
  assert.equal(latest.status, 'accepted');
  assert.deepEqual(payments, [latest.payment]);
  assert.deepEqual(attempts.map(({ revision, status }) => [revision, status]), [[replacement.revision, 'committed']]);
  assert.equal(desk.check().payment.key, latest.payment.key);
});

test('payment remains pending when settlement time is ambiguous, invalid, or precedes acceptance', t => {
  const desk = setup(t);
  const invoice = desk.check();
  desk.update({ approval: approve(invoice) });
  const { paymentRef, invoiceId, revision, payee, amountMinor, currency } = desk.check().payment;
  const receipt = { paymentRef, invoiceId, revision, payee, amountMinor, currency, status: 'settled' };

  for (const settledAt of [
    '2026-11-22T05:30:00.000Z', '2026-11-24T05:30:00',
    '2026-11-24T24:00:00.000Z', '2026-11-31T05:30:00.000Z'
  ]) {
    desk.fixture.putSettlement({ ...receipt, settledAt });
    assert.equal(desk.check().status, 'accepted');
  }

  desk.fixture.putSettlement({ ...receipt, settledAt: later });
  assert.equal(desk.check().status, 'verified');
});
