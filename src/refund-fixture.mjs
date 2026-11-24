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

export class RefundFeedUnavailable extends Error {
  constructor(source) {
    super('The refund source is unavailable.');
    this.source = source;
  }
}

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
    CREATE TABLE IF NOT EXISTS refund_unavailable_sources (
      source TEXT PRIMARY KEY CHECK (source IN ('merchant', 'credits'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS refund_failed_reads (
      readId INTEGER PRIMARY KEY REFERENCES refund_reads(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS refund_checkpoint_reads (
      checkpoint TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('merchant', 'credits')),
      attempt INTEGER NOT NULL CHECK (attempt IN (1, 2)),
      binding TEXT NOT NULL,
      input TEXT NOT NULL,
      readId INTEGER NOT NULL UNIQUE REFERENCES refund_reads(id),
      records TEXT,
      PRIMARY KEY (checkpoint, source, attempt)
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
    FROM ledger_credits WHERE account = ? AND direction = 'incoming' AND (
      returnReference = ? OR (returnReference IS NULL AND id IN (SELECT value FROM json_each(?)))
    )
    ORDER BY postedAt, id
  `);
  const writeRead = database.prepare('INSERT INTO refund_reads(source, scope, checkedAt) VALUES (?, ?, ?)');
  const unavailableSource = database.prepare('SELECT source FROM refund_unavailable_sources WHERE source = ?');
  const disconnect = database.prepare('INSERT OR IGNORE INTO refund_unavailable_sources VALUES (?)');
  const reconnect = database.prepare('DELETE FROM refund_unavailable_sources WHERE source = ?');
  const writeFailedRead = database.prepare('INSERT INTO refund_failed_reads VALUES (?)');
  const priorBinding = database.prepare('SELECT binding FROM refund_checkpoint_reads WHERE checkpoint = ? LIMIT 1');
  const priorRead = database.prepare(`
    SELECT saved.input, saved.records, native.checkedAt FROM refund_checkpoint_reads AS saved
    JOIN refund_reads AS native ON native.id = saved.readId
    WHERE saved.checkpoint = ? AND saved.source = ? AND saved.attempt = ?
  `);
  const saveCheckpointRead = database.prepare('INSERT INTO refund_checkpoint_reads VALUES (?, ?, ?, ?, ?, ?, ?)');

  let inTransaction = false;
  function transaction(action) {
    if (inTransaction) return action();
    database.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      inTransaction = false;
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

  function prepareRead(source, input) {
    const { reference } = input;
    if (source === 'merchant') {
      const { issuer, thread } = input;
      return {
        scope: { issuer, thread, reference },
        read: () => ({
          events: plainRows(merchantEvents.all(issuer, thread, reference)),
          links: plainRows(merchantLinks.all(issuer, thread, reference))
        })
      };
    }
    const { account, linkedCreditIds = [] } = input;
    let confirmedIds = [];
    if (linkedCreditIds.length && account === mondayRefund.account && reference === mondayRefund.reference) {
      const requestedIds = new Set(linkedCreditIds);
      confirmedIds = merchantLinks.all(mondayRefund.merchantIssuer, mondayRefund.thread, reference)
        .map(link => link.creditId)
        .filter(id => requestedIds.has(id));
    }
    return {
      scope: { account, reference, linkedCreditIds: confirmedIds },
      read: () => plainRows(scopedCredits.all(account, reference, JSON.stringify(confirmedIds)))
    };
  }

  function readScoped(source, input, authorize, replay) {
    return transaction(() => {
      const now = clock();
      if (authorize && !authorize(now)) return { status: 'denied' };
      const serializedInput = replay ? JSON.stringify(input) : null;
      if (replay) {
        const prior = priorBinding.get(replay.key);
        if (prior && prior.binding !== replay.binding) return { status: 'superseded' };
        const saved = priorRead.get(replay.key, source, replay.attempt);
        if (saved) {
          if (saved.input !== serializedInput) return { status: 'superseded' };
          return saved.records === null ? { status: 'unavailable' }
            : { status: 'checked', records: JSON.parse(saved.records), checkedAt: saved.checkedAt };
        }
      }
      const { scope, read } = prepareRead(source, input);
      const checkedAt = now.toISOString();
      const { lastInsertRowid: readId } = writeRead.run(source, JSON.stringify(scope), checkedAt);
      const records = unavailableSource.get(source) ? null : read();
      if (records === null) writeFailedRead.run(readId);
      if (replay) {
        saveCheckpointRead.run(replay.key, source, replay.attempt, replay.binding, serializedInput, readId,
          records === null ? null : JSON.stringify(records));
      }
      return records === null ? { status: 'unavailable' } : { status: 'checked', records, checkedAt };
    });
  }

  function readOrUnavailable(source, scope, authorize) {
    const result = readScoped(source, scope, authorize);
    if (result.status === 'unavailable') throw new RefundFeedUnavailable(source);
    return result.records;
  }

  return {
    subject: mondayRefund,
    withinSnapshot: transaction,
    reset() {
      transaction(() => {
        database.exec(`
          DELETE FROM refund_checkpoint_reads; DELETE FROM refund_failed_reads;
          DELETE FROM refund_reads; DELETE FROM refund_unavailable_sources;
          DELETE FROM merchant_events; DELETE FROM return_links; DELETE FROM ledger_credits;
        `);
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
    setAvailable(source, available) {
      if ((source !== 'merchant' && source !== 'credits') || typeof available !== 'boolean') {
        throw new TypeError('Choose a known refund source and whether it is available.');
      }
      if (available) reconnect.run(source);
      else disconnect.run(source);
    },
    readMerchant: (scope, authorize) => readOrUnavailable('merchant', scope, authorize),
    readCredits: (scope, authorize) => readOrUnavailable('credits', scope, authorize),
    readForCheck(source, scope, { authorize, replay }) {
      if ((source !== 'merchant' && source !== 'credits') || typeof authorize !== 'function') {
        throw new TypeError('Confirm the scope and current grant before checking this refund source.');
      }
      return readScoped(source, scope, authorize, replay);
    },
    inspect() {
      return {
        events: plainRows(database.prepare('SELECT * FROM merchant_events ORDER BY occurredAt, id').all()),
        links: plainRows(database.prepare('SELECT * FROM return_links ORDER BY issuer, thread, returnReference, creditId').all()),
        credits: plainRows(database.prepare('SELECT * FROM ledger_credits ORDER BY postedAt, id').all()),
        reads: database.prepare(`
          SELECT source, scope, checkedAt, failed.readId IS NOT NULL AS unavailable
          FROM refund_reads LEFT JOIN refund_failed_reads AS failed ON failed.readId = refund_reads.id
          ORDER BY refund_reads.id
        `).all().map(({ source, scope, checkedAt, unavailable }) => ({
          source, scope: JSON.parse(scope), checkedAt, ...(unavailable ? { status: 'unavailable' } : {})
        }))
      };
    },
    putCredit,
    putLink,
    putEvent,
    close: () => database.close()
  };
}
