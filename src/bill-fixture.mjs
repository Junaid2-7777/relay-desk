import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const mondayBill = Object.freeze({
  invoiceId: 'electricity-2026-11',
  revision: 2,
  payee: 'city-electric',
  payeeLabel: 'City Electric',
  amountMinor: 118000,
  currency: 'INR'
});

export class BillFixtureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const plain = row => row ? { ...row } : null;

function sameTerms(record, intent) {
  return record.invoiceId === intent.invoiceId && record.revision === intent.revision &&
    record.payee === intent.payee && record.amountMinor === intent.amountMinor && record.currency === intent.currency;
}

export function openBillFixture({ dataDir, clock = () => new Date() }) {
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, 'providers.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS bill_invoices (
      invoiceId TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      payee TEXT NOT NULL,
      payeeLabel TEXT NOT NULL,
      amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
      currency TEXT NOT NULL,
      PRIMARY KEY (invoiceId, revision)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bill_payments (
      key TEXT PRIMARY KEY,
      invoiceId TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL,
      payee TEXT NOT NULL,
      amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
      currency TEXT NOT NULL,
      paymentRef TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status = 'accepted'),
      acceptedAt TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bill_settlements (
      paymentRef TEXT PRIMARY KEY,
      invoiceId TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payee TEXT NOT NULL,
      amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      settledAt TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bill_attempts (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL,
      invoiceId TEXT NOT NULL,
      revision INTEGER NOT NULL,
      attemptedAt TEXT NOT NULL,
      status TEXT NOT NULL,
      code TEXT,
      paymentRef TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bill_reads (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('invoice', 'payment', 'settlement')),
      scope TEXT NOT NULL,
      checkedAt TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bill_faults (name TEXT PRIMARY KEY) STRICT;
  `);

  const writeInvoice = database.prepare(`
    INSERT INTO bill_invoices VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(invoiceId, revision) DO UPDATE SET payee = excluded.payee,
      payeeLabel = excluded.payeeLabel, amountMinor = excluded.amountMinor, currency = excluded.currency
  `);
  const latestInvoice = database.prepare('SELECT * FROM bill_invoices WHERE invoiceId = ? ORDER BY revision DESC LIMIT 1');
  const findPayment = database.prepare('SELECT * FROM bill_payments WHERE key = ?');
  const hasPayment = database.prepare('SELECT 1 FROM bill_payments WHERE invoiceId = ?');
  const spendForPayee = database.prepare(`
    SELECT COALESCE(SUM(amountMinor), 0) AS spentMinor, COUNT(*) AS count
    FROM bill_payments WHERE payee = ? AND currency = ?
  `);
  const writePayment = database.prepare('INSERT INTO bill_payments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const writeSettlement = database.prepare(`
    INSERT INTO bill_settlements VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(paymentRef) DO UPDATE SET invoiceId = excluded.invoiceId, revision = excluded.revision,
      payee = excluded.payee, amountMinor = excluded.amountMinor, currency = excluded.currency,
      status = excluded.status, settledAt = excluded.settledAt
  `);
  const findSettlement = database.prepare('SELECT * FROM bill_settlements WHERE paymentRef = ?');
  const writeAttempt = database.prepare(`
    INSERT INTO bill_attempts (key, invoiceId, revision, attemptedAt, status, code, paymentRef)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const writeRead = database.prepare('INSERT INTO bill_reads (source, scope, checkedAt) VALUES (?, ?, ?)');
  const listReads = database.prepare('SELECT source, scope, checkedAt FROM bill_reads ORDER BY id');
  const setLostReply = database.prepare("INSERT OR IGNORE INTO bill_faults VALUES ('lost-reply')");
  const consumeLostReply = database.prepare("DELETE FROM bill_faults WHERE name = 'lost-reply'");

  function transaction(action) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function read(source, scope, lookup) {
    return transaction(() => {
      writeRead.run(source, JSON.stringify(scope), clock().toISOString());
      return plain(lookup());
    });
  }

  function putInvoice({ invoiceId, revision, payee, payeeLabel, amountMinor, currency }) {
    writeInvoice.run(invoiceId, revision, payee, payeeLabel, amountMinor, currency);
  }

  function putSettlement({ paymentRef, invoiceId, revision, payee, amountMinor, currency, status, settledAt }) {
    writeSettlement.run(paymentRef, invoiceId, revision, payee, amountMinor, currency, status, settledAt);
  }

  function pay({ key, invoiceId, revision, payee, amountMinor, currency }, authorize) {
    if (typeof key !== 'string' || !key || typeof invoiceId !== 'string' || !invoiceId ||
        typeof payee !== 'string' || !payee || typeof currency !== 'string' || !/^[A-Z]{3}$/u.test(currency) ||
        !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(amountMinor) || amountMinor < 1) {
      throw new BillFixtureError('invalid-payment', 'The exact invoice and payment terms are required.');
    }
    const intent = Object.freeze({ key, invoiceId, revision, payee, amountMinor, currency });

    const result = transaction(() => {
      const attemptedAt = clock().toISOString();
      const log = (status, code = null, paymentRef = null) =>
        writeAttempt.run(key, invoiceId, revision, attemptedAt, status, code, paymentRef);
      const block = (code, message) => {
        log('blocked', code);
        return { error: new BillFixtureError(code, message) };
      };

      const existing = plain(findPayment.get(key));
      if (existing) {
        if (!sameTerms(existing, intent)) return block('operation-mismatch', 'The payment key already belongs to different terms.');
        log('recovered', null, existing.paymentRef);
        return { payment: existing };
      }

      const current = latestInvoice.get(invoiceId);
      if (!current || !sameTerms(current, intent)) return block('invoice-changed', 'Review the current invoice before paying.');
      if (hasPayment.get(invoiceId)) return block('already-paid', 'The biller already accepted a payment for this invoice.');

      const totals = Object.freeze(plain(spendForPayee.get(payee, currency)));
      let permitted;
      try {
        permitted = typeof authorize === 'function' && authorize(intent, totals) === true;
      } catch (error) {
        log('blocked', 'authorization-error');
        return { error };
      }
      if (!permitted) return block('not-authorized', 'The current permission does not cover this payment.');

      const paymentRef = `payment-${randomUUID()}`;
      const payment = { ...intent, paymentRef, status: 'accepted', acceptedAt: attemptedAt };
      writePayment.run(key, invoiceId, revision, payee, amountMinor, currency, paymentRef, payment.status, attemptedAt);
      const replyLost = consumeLostReply.run().changes === 1;
      log(replyLost ? 'reply-lost' : 'committed', null, paymentRef);
      return { payment, replyLost };
    });

    if ('error' in result) throw result.error;
    if (result.replyLost) {
      throw new BillFixtureError('outcome-unknown', 'The biller response did not arrive. Check the original operation.');
    }
    return result.payment;
  }

  return {
    reset() {
      transaction(() => {
        database.exec('DELETE FROM bill_attempts; DELETE FROM bill_settlements; DELETE FROM bill_payments; DELETE FROM bill_invoices;');
        database.exec('DELETE FROM bill_faults; DELETE FROM bill_reads;');
        putInvoice({ ...mondayBill, revision: 1, amountMinor: 85000 });
        putInvoice(mondayBill);
      });
    },
    putInvoice,
    readInvoice: invoiceId => read('invoice', { invoiceId }, () => latestInvoice.get(invoiceId)),
    pay,
    paymentByKey: key => read('payment', { key }, () => findPayment.get(key)),
    putSettlement,
    readSettlement: paymentRef => read('settlement', { paymentRef }, () => findSettlement.get(paymentRef)),
    inspect: () => ({
      invoices: database.prepare('SELECT * FROM bill_invoices ORDER BY invoiceId, revision').all().map(plain),
      payments: database.prepare('SELECT * FROM bill_payments ORDER BY rowid').all().map(plain),
      settlements: database.prepare('SELECT * FROM bill_settlements ORDER BY rowid').all().map(plain),
      attempts: database.prepare('SELECT * FROM bill_attempts ORDER BY id').all().map(plain),
      reads: listReads.all().map(row => ({ ...row, scope: JSON.parse(row.scope) }))
    }),
    failNextReply: () => { setLostReply.run(); },
    close: () => database.close()
  };
}
