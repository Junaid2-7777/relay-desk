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
  `);

  const find = database.prepare('SELECT * FROM outbox_messages WHERE key = ?');
  const insert = database.prepare("INSERT INTO outbox_messages VALUES (?, ?, ?, ?, 'queued', ?)");
  const list = database.prepare('SELECT * FROM outbox_messages ORDER BY rowid');

  function get(key) {
    const row = find.get(key);
    return row ? { ...row } : null;
  }

  function enqueue({ key, recipient, subject, text }, authorize) {
    if (![key, recipient, subject, text].every(textPresent)) {
      throw new OutboxFixtureError('invalid-message', 'The exact recipient, subject and message are required.');
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      const original = get(key);
      if (original && (original.recipient !== recipient || original.subject !== subject || original.text !== text)) {
        throw new OutboxFixtureError('operation-mismatch', 'The message key already belongs to a different draft.');
      }

      let message = original;
      if (!message) {
        const draft = Object.freeze({ key, recipient, subject, text });
        if (typeof authorize !== 'function' || authorize(draft) !== true) {
          throw new OutboxFixtureError('not-authorized', 'The exact draft needs approval before it can be queued.');
        }
        const queuedAt = clock().toISOString();
        insert.run(key, recipient, subject, text, queuedAt);
        message = { ...draft, status: 'queued', queuedAt };
      }

      database.exec('COMMIT');
      return message;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    reset: () => { database.exec('DELETE FROM outbox_messages'); },
    enqueue,
    get,
    inspect: () => ({ messages: list.all().map(row => ({ ...row })) }),
    close: () => database.close()
  };
}
