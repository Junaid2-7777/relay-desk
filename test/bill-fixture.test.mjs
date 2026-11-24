import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { mondayBill, openBillFixture } from '../src/bill-fixture.mjs';

const acceptedAt = '2026-11-23T03:30:00.000Z';
const settledAt = '2026-11-24T03:30:00.000Z';

function fixtureDirectory(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-bill-fixture-'));
  t.after(() => rmSync(dataDir, { force: true, recursive: true }));
  return dataDir;
}

function request(invoice, key) {
  const { invoiceId, revision, payee, amountMinor, currency } = invoice;
  return { key, invoiceId, revision, payee, amountMinor, currency };
}

test('a replaced invoice and a same-label payee change block stale authorization', t => {
  const dataDir = fixtureDirectory(t);
  const fixture = openBillFixture({ dataDir, clock: () => new Date(acceptedAt) });
  try {
    fixture.reset();
    const [initial, replacement] = fixture.inspect().invoices;
    assert.equal(initial.amountMinor, 85000);
    assert.deepEqual(replacement, mondayBill);
    assert.deepEqual(fixture.readInvoice(mondayBill.invoiceId), replacement);

    assert.throws(() => fixture.pay(request(initial, 'old-approval'), () => assert.fail('stale revision')), { code: 'invoice-changed' });
    fixture.putInvoice({ ...replacement, payee: 'other-payee' });
    assert.throws(() => fixture.pay(request(replacement, 'exact-approval'), () => assert.fail('old payee')), { code: 'invoice-changed' });
    const after = fixture.inspect();
    assert.equal(after.payments.length, 0);
    assert.deepEqual(after.attempts.map(({ status, code }) => ({ status, code })), [
      { status: 'blocked', code: 'invoice-changed' },
      { status: 'blocked', code: 'invoice-changed' }
    ]);
  } finally {
    fixture.close();
  }
});

test('refuses an unauthorized payment without creating an acceptance or settlement', t => {
  const dataDir = fixtureDirectory(t);
  const fixture = openBillFixture({ dataDir, clock: () => new Date(acceptedAt) });
  try {
    fixture.reset();
    const intent = request(mondayBill, 'declined-approval');
    assert.throws(() => fixture.pay(intent, () => false), { code: 'not-authorized' });
    assert.equal(fixture.paymentByKey(intent.key), null);
    assert.deepEqual(fixture.inspect().settlements, []);
  } finally {
    fixture.close();
  }
});

test('recovers one accepted payment across a lost response and restart, then reads settlement independently', t => {
  const dataDir = fixtureDirectory(t);
  const intent = request(mondayBill, 'one-time-approval');
  const before = openBillFixture({ dataDir, clock: () => new Date(acceptedAt) });
  try {
    before.reset();
    const operator = openBillFixture({ dataDir });
    try {
      operator.failNextReply();
    } finally {
      operator.close();
    }
    assert.throws(() => before.pay(intent, (terms, totals) => {
      assert.deepEqual(terms, intent);
      assert.deepEqual(totals, { spentMinor: 0, count: 0 });
      return true;
    }), { code: 'outcome-unknown' });
  } finally {
    before.close();
  }

  const after = openBillFixture({ dataDir, clock: () => new Date(settledAt) });
  try {
    const payment = after.paymentByKey(intent.key);
    assert.equal(payment.acceptedAt, acceptedAt);
    assert.equal(payment.status, 'accepted');
    assert.equal(after.readSettlement(payment.paymentRef), null);
    assert.deepEqual(after.pay(intent, () => assert.fail('a native readback needs no second debit')), payment);
    assert.throws(() => after.pay({ ...intent, amountMinor: 118001 }, () => true), { code: 'operation-mismatch' });
    assert.throws(() => after.pay({ ...intent, key: 'new-key' }, () => true), { code: 'already-paid' });

    const { invoiceId, revision, payee, amountMinor, currency, paymentRef } = payment;
    const settlement = { invoiceId, revision, payee, amountMinor, currency, paymentRef, status: 'settled', settledAt };
    after.putSettlement(settlement);
    assert.deepEqual(after.readSettlement(paymentRef), settlement);
    assert.deepEqual(after.inspect().payments, [payment]);
    assert.deepEqual(after.inspect().attempts.map(({ status }) => status), ['reply-lost', 'recovered', 'blocked', 'blocked']);

    after.reset();
    assert.deepEqual(after.inspect().settlements, []);
    assert.deepEqual(after.inspect().payments, []);
    assert.deepEqual(after.inspect().attempts, []);
  } finally {
    after.close();
  }
});

test('competing payments share the budget at the provider commit boundary', async t => {
  const dataDir = fixtureDirectory(t);
  const fixture = openBillFixture({ dataDir, clock: () => new Date(acceptedAt) });
  const firstInvoice = { ...mondayBill, invoiceId: 'first-eligible-invoice', revision: 1, amountMinor: 50000 };
  const secondInvoice = { ...firstInvoice, invoiceId: 'second-eligible-invoice' };
  const workerSource = `
    import { parentPort, workerData } from 'node:worker_threads';
    const { openBillFixture } = await import(workerData.fixtureModule);
    const provider = openBillFixture({ dataDir: workerData.dataDir, clock: () => new Date(workerData.acceptedAt) });
    parentPort.once('message', intent => {
      try {
        provider.pay(intent, ({ amountMinor }, { spentMinor }) => spentMinor + amountMinor <= 90000);
        parentPort.postMessage('committed');
      } catch (error) {
        parentPort.postMessage(error.code ?? error.message);
      } finally {
        provider.close();
      }
    });
    parentPort.postMessage('ready');
  `;
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`);
  const workerData = { dataDir, acceptedAt, fixtureModule: import.meta.resolve('../src/bill-fixture.mjs') };
  const workers = [];
  try {
    fixture.putInvoice(firstInvoice);
    fixture.putInvoice(secondInvoice);
    workers.push(new Worker(workerUrl, { workerData }), new Worker(workerUrl, { workerData }));
    const ready = await Promise.all(workers.map(worker => once(worker, 'message')));
    assert.deepEqual(ready.flat(), ['ready', 'ready']);
    const results = workers.map(worker => once(worker, 'message'));
    workers[0].postMessage(request(firstInvoice, 'first'));
    workers[1].postMessage(request(secondInvoice, 'second'));
    assert.deepEqual((await Promise.all(results)).flat().sort(), ['committed', 'not-authorized']);
    const { payments, attempts } = fixture.inspect();
    assert.deepEqual(payments.map(({ amountMinor }) => amountMinor), [50000]);
    assert.deepEqual(attempts.map(({ status, code }) => ({ status, code })), [
      { status: 'committed', code: null }, { status: 'blocked', code: 'not-authorized' }
    ]);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    fixture.close();
  }
});
