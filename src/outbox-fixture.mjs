import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class OutboxFixtureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const textPresent = value => typeof value === 'string' && value.trim().length > 0;

export function openOutboxFixture({ dataDir, clock = () => new Date() }) {
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, 'providers.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS outbox_messages (
      key TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status = 'queued'),
      queuedAt TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS outbox_attempts (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('committed', 'recovered', 'blocked')),
      code TEXT,
      attemptedAt TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS outbox_faults (name TEXT PRIMARY KEY) STRICT;
  `);

  const find = database.prepare('SELECT * FROM outbox_messages WHERE key = ?');
  const insert = database.prepare("INSERT INTO outbox_messages VALUES (?, ?, ?, ?, 'queued', ?)");
  const list = database.prepare('SELECT * FROM outbox_messages ORDER BY rowid');
  const writeAttempt = database.prepare('INSERT INTO outbox_attempts (key, status, code, attemptedAt) VALUES (?, ?, ?, ?)');
  const listAttempts = database.prepare('SELECT key, status, code, attemptedAt FROM outbox_attempts ORDER BY id');
  const queueFault = database.prepare('INSERT OR IGNORE INTO outbox_faults VALUES (?)');
  const consumeFault = database.prepare('DELETE FROM outbox_faults WHERE name = ?');

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

  function findMessage(key) {
    const row = find.get(key);
    return row ? { ...row } : null;
  }

  function get(key) {
    if (consumeFault.run('readback-unavailable').changes) {
      throw new OutboxFixtureError('read-unavailable', 'The original practice outbox entry could not be checked.');
    }
    return findMessage(key);
  }

  function enqueue({ key, recipient, subject, text }, authorize) {
    if (![key, recipient, subject, text].every(textPresent)) {
      throw new OutboxFixtureError('invalid-message', 'The exact recipient, subject and message are required.');
    }

    const result = transaction(() => {
      const attemptedAt = clock().toISOString();
      const log = (status, code = null) => writeAttempt.run(key, status, code, attemptedAt);
      const block = (code, message) => {
        log('blocked', code);
        return { error: new OutboxFixtureError(code, message) };
      };
      const original = findMessage(key);
      if (original) {
        if (original.recipient !== recipient || original.subject !== subject || original.text !== text) {
          return block('operation-mismatch', 'The message key already belongs to a different draft.');
        }
        log('recovered');
        return { message: original };
      }

      const draft = Object.freeze({ key, recipient, subject, text });
      let permitted;
      try {
        permitted = typeof authorize === 'function' && authorize(draft) === true;
      } catch (error) {
        log('blocked', 'authorization-error');
        return { error };
      }
      if (!permitted) {
        return block('not-authorized', 'The exact draft needs approval before it can be queued.');
      }
      const queuedAt = clock().toISOString();
      insert.run(key, recipient, subject, text, queuedAt);
      const replyLost = consumeFault.run('reply-lost').changes > 0;
      log('committed', replyLost ? 'reply-lost' : null);
      return { message: { ...draft, status: 'queued', queuedAt }, replyLost };
    });
    if ('error' in result) throw result.error;
    if (result.replyLost) {
      throw new OutboxFixtureError('outcome-unknown', 'The practice outbox response did not arrive. Check the original draft.');
    }
    return result.message;
  }

  return {
    reset: () => transaction(() => database.exec('DELETE FROM outbox_messages; DELETE FROM outbox_attempts; DELETE FROM outbox_faults;')),
    enqueue,
    get,
    inspect: () => ({
      messages: list.all().map(row => ({ ...row })),
      attempts: listAttempts.all().map(row => ({ ...row }))
    }),
    failNextReply: () => { queueFault.run('reply-lost'); },
    failNextReadback: () => { queueFault.run('readback-unavailable'); },
    close: () => database.close()
  };
}
