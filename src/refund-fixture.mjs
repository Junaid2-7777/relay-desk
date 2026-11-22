import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const mondayRefund = Object.freeze({
  reference: 'return-demo-1249',
  account: 'ledger-demo-household',
  amountMinor: 124900,
  currency: 'INR',
  merchantIssuer: 'merchant-demo-shop',
  thread: 'thread-demo-refund'
});

const monday = '2026-11-22T18:30:00.000Z';
const plainRows = rows => rows.map(row => ({ ...row }));

export function openRefundFixture({ dataDir, clock = () => new Date() }) {
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, 'refund-fixture.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS merchant_events (
      id TEXT PRIMARY KEY,
      issuer TEXT NOT NULL,
      thread TEXT NOT NULL,
      returnReference TEXT NOT NULL,
      occurredAt TEXT NOT NULL,
      type TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS return_links (
      issuer TEXT NOT NULL,
      thread TEXT NOT NULL,
      returnReference TEXT NOT NULL,
      creditId TEXT NOT NULL,
      PRIMARY KEY (issuer, thread, returnReference, creditId)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ledger_credits (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      amountMinor INTEGER NOT NULL CHECK (amountMinor >= 0),
      currency TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
      status TEXT NOT NULL CHECK (status IN ('posted', 'pending')),
      returnReference TEXT,
      postedAt TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ledger_credit_scope ON ledger_credits(account, returnReference);
    CREATE TABLE IF NOT EXISTS refund_reads (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      scope TEXT NOT NULL,
      checkedAt TEXT NOT NULL
    ) STRICT;
  `);

  const writeEvent = database.prepare(`
    INSERT INTO merchant_events VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET issuer = excluded.issuer, thread = excluded.thread,
      returnReference = excluded.returnReference, occurredAt = excluded.occurredAt, type = excluded.type
  `);
  const writeCredit = database.prepare(`
    INSERT INTO ledger_credits VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET account = excluded.account, amountMinor = excluded.amountMinor,
      currency = excluded.currency, direction = excluded.direction, status = excluded.status,
      returnReference = excluded.returnReference, postedAt = excluded.postedAt
  `);
  const writeLink = database.prepare('INSERT OR IGNORE INTO return_links VALUES (?, ?, ?, ?)');
  const merchantEvents = database.prepare(`
    SELECT id, issuer, thread, returnReference, occurredAt, type FROM merchant_events
    WHERE issuer = ? AND thread = ? AND returnReference = ?
    ORDER BY occurredAt, id
  `);
  const merchantLinks = database.prepare(`
    SELECT link.issuer, link.thread, link.returnReference, link.creditId
    FROM return_links AS link
    WHERE link.issuer = ? AND link.thread = ? AND link.returnReference = ?
      AND NOT EXISTS (
        SELECT 1 FROM return_links AS other WHERE other.issuer = link.issuer AND other.thread = link.thread
          AND other.creditId = link.creditId AND other.returnReference <> link.returnReference
      )
    ORDER BY link.creditId
  `);
  const scopedCredits = database.prepare(`
    SELECT id, account, amountMinor, currency, direction, status, returnReference, postedAt
    FROM ledger_credits WHERE account = ? AND (
      returnReference = ? OR (returnReference IS NULL AND id IN (SELECT value FROM json_each(?)))
    )
    ORDER BY postedAt, id
  `);
  const writeRead = database.prepare('INSERT INTO refund_reads(source, scope, checkedAt) VALUES (?, ?, ?)');

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

  function putEvent(event) {
    writeEvent.run(event.id, event.issuer, event.thread, event.returnReference, event.occurredAt, event.type);
  }

  function putCredit(credit) {
    writeCredit.run(
      credit.id, credit.account, credit.amountMinor, credit.currency, credit.direction,
      credit.status, credit.returnReference ?? null, credit.postedAt ?? null
    );
  }

  function putLink(link) {
    writeLink.run(link.issuer, link.thread, link.returnReference, link.creditId);
  }

  function logRead(source, scope) {
    writeRead.run(source, JSON.stringify(scope), clock().toISOString());
  }

  return {
    subject: mondayRefund,
    reset() {
      transaction(() => {
        database.exec('DELETE FROM merchant_events; DELETE FROM return_links; DELETE FROM ledger_credits; DELETE FROM refund_reads;');
        putEvent({
          id: 'event-demo-refund-promise',
          issuer: mondayRefund.merchantIssuer,
          thread: mondayRefund.thread,
          returnReference: mondayRefund.reference,
          occurredAt: monday,
          type: 'promise'
        });
        putCredit({
          id: 'credit-demo-unrelated-return',
          account: mondayRefund.account,
          amountMinor: mondayRefund.amountMinor,
          currency: mondayRefund.currency,
          direction: 'incoming',
          status: 'posted',
          returnReference: 'return-demo-unrelated',
          postedAt: monday
        });
      });
    },
    readMerchant({ issuer, thread, reference }) {
      return transaction(() => {
        logRead('merchant', { issuer, thread, reference });
        return {
          events: plainRows(merchantEvents.all(issuer, thread, reference)),
          links: plainRows(merchantLinks.all(issuer, thread, reference))
        };
      });
    },
    readCredits({ account, reference, linkedCreditIds = [] }) {
      return transaction(() => {
        let confirmedIds = [];
        if (linkedCreditIds.length && account === mondayRefund.account && reference === mondayRefund.reference) {
          const requestedIds = new Set(linkedCreditIds);
          confirmedIds = merchantLinks.all(mondayRefund.merchantIssuer, mondayRefund.thread, reference)
            .map(link => link.creditId)
            .filter(id => requestedIds.has(id));
        }
        logRead('credits', { account, reference, linkedCreditIds: confirmedIds });
        return plainRows(scopedCredits.all(account, reference, JSON.stringify(confirmedIds)));
      });
    },
    inspect() {
      return {
        events: plainRows(database.prepare('SELECT * FROM merchant_events ORDER BY occurredAt, id').all()),
        links: plainRows(database.prepare('SELECT * FROM return_links ORDER BY issuer, thread, returnReference, creditId').all()),
        credits: plainRows(database.prepare('SELECT * FROM ledger_credits ORDER BY postedAt, id').all()),
        reads: database.prepare('SELECT source, scope, checkedAt FROM refund_reads ORDER BY id').all()
          .map(row => ({ ...row, scope: JSON.parse(row.scope) }))
      };
    },
    putCredit,
    putLink,
    putEvent,
    close: () => database.close()
  };
}
