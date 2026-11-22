import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const practiceReceiptSource = Object.freeze({ issuer: 'library-practice', label: 'Practice library' });
export class ReceiptPlanError extends Error {}

const identifier = /^[a-z0-9][a-z0-9._:-]{0,99}$/iu;

export function isReceiptIdentifier(value) {
  return typeof value === 'string' && identifier.test(value);
}

export function receiptIdentifier(value, label) {
  if (typeof value !== 'string' || !isReceiptIdentifier(value.trim())) {
    throw new ReceiptPlanError(`Enter ${label} with up to 100 letters, digits or reference punctuation.`);
  }
  return value.trim();
}

function receiptRecord(row) {
  const { fields, ...receipt } = row;
  return fields === null ? receipt : { ...receipt, fields: JSON.parse(fields) };
}

export function openReceiptFixture({ dataDir, clock = () => new Date() }) {
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, 'providers.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS receipt_sources (
      issuer TEXT PRIMARY KEY,
      label TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS receipt_records (
      issuer TEXT NOT NULL REFERENCES receipt_sources(issuer),
      id TEXT NOT NULL,
      subject TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      occurredAt TEXT NOT NULL,
      fields TEXT,
      PRIMARY KEY (issuer, id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS receipt_scope ON receipt_records(issuer, subject);
    CREATE TABLE IF NOT EXISTS receipt_reads (
      id INTEGER PRIMARY KEY,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      checkedAt TEXT NOT NULL
    ) STRICT;
  `);
  const insertSource = database.prepare(`
    INSERT INTO receipt_sources VALUES (?, ?)
    ON CONFLICT(issuer) DO UPDATE SET label = excluded.label
  `);
  const insertReceipt = database.prepare(`
    INSERT INTO receipt_records VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(issuer, id) DO UPDATE SET subject = excluded.subject, type = excluded.type,
      status = excluded.status, occurredAt = excluded.occurredAt, fields = excluded.fields
  `);
  const selectSources = database.prepare('SELECT issuer, label FROM receipt_sources ORDER BY issuer');
  const issuerExists = database.prepare('SELECT 1 FROM receipt_sources WHERE issuer = ?');
  const scopedReceipts = database.prepare(`
    SELECT id, issuer, subject, type, status, occurredAt
    FROM receipt_records WHERE issuer = ? AND subject = ? ORDER BY occurredAt, id
  `);
  const insertRead = database.prepare('INSERT INTO receipt_reads (issuer, subject, checkedAt) VALUES (?, ?, ?)');
  const sources = () => selectSources.all().map(row => ({ ...row }));

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

  function putSource({ issuer, label }) {
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 100) {
      throw new ReceiptPlanError('Enter a source label with up to 100 characters.');
    }
    insertSource.run(receiptIdentifier(issuer, 'an issuer identifier'), label.trim());
  }

  return {
    putSource,
    putReceipt(receipt) {
      const issuer = receiptIdentifier(receipt.issuer, 'an issuer identifier');
      const subject = receiptIdentifier(receipt.subject, 'a subject reference');
      const type = receiptIdentifier(receipt.type, 'a record type');
      const status = receiptIdentifier(receipt.status, 'a record status');
      const id = receiptIdentifier(receipt.id, 'a receipt identifier');
      const fields = receipt.fields === undefined ? null : JSON.stringify(receipt.fields);
      insertReceipt.run(issuer, id, subject, type, status, receipt.occurredAt, fields);
    },
    read(scope) {
      const issuer = receiptIdentifier(scope.issuer, 'an issuer identifier');
      const subject = receiptIdentifier(scope.subject, 'a subject reference');
      return transaction(() => {
        if (!issuerExists.get(issuer)) throw new ReceiptPlanError('This issuer has no registered receipt source.');
        insertRead.run(issuer, subject, clock().toISOString());
        return scopedReceipts.all(issuer, subject).map(row => ({ ...row }));
      });
    },
    sources,
    reset() {
      transaction(() => {
        database.exec('DELETE FROM receipt_reads; DELETE FROM receipt_records; DELETE FROM receipt_sources;');
        putSource(practiceReceiptSource);
      });
    },
    inspect: () => ({
      sources: sources(),
      receipts: database.prepare('SELECT * FROM receipt_records ORDER BY issuer, subject, occurredAt, id').all().map(receiptRecord),
      reads: database.prepare('SELECT issuer, subject, checkedAt FROM receipt_reads ORDER BY id').all().map(row => ({ ...row }))
    }),
    close: () => database.close()
  };
}
