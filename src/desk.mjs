import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { previewErrand } from './intake.mjs';

export class DeskError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });

export function localDay(date) {
  const values = Object.fromEntries(dayFormat.formatToParts(date).map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function requiredText(value, label, limit) {
  if (typeof value !== 'string' || !value.trim()) throw new DeskError(`Enter ${label}.`);
  if (value.trim().length > limit) throw new DeskError(`Keep ${label} within ${limit} characters.`);
  return value.trim();
}

function optionalDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(value);
    if (Number.isFinite(+date) && date.toISOString().slice(0, 10) === value) return value;
  }
  throw new DeskError('Choose a valid check date.');
}

const readErrand = row => row && JSON.parse(row.record);

export function openDesk({ dataDir, clock = () => new Date() }) {
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, 'desk.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS errands (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      record TEXT NOT NULL
    ) STRICT;
  `);
  const get = database.prepare('SELECT record FROM errands WHERE id = ?');
  const find = id => {
    const errand = readErrand(get.get(id));
    if (!errand) throw new DeskError('This errand could not be found.', 404);
    return errand;
  };
  const list = () => database.prepare('SELECT record FROM errands ORDER BY rowid DESC').all().map(readErrand);
  const today = () => localDay(clock());
  const preview = note => previewErrand(requiredText(note, 'an errand', 4000), today());

  return {
    brief: () => ({ today: today(), errands: list() }),
    preview,
    save({ note, goal, checkDate, requestId }) {
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId))) {
        throw new DeskError('Use a valid save reference.');
      }
      const proposal = preview(note);
      const record = {
        id: requestId ?? randomUUID(),
        revision: 1,
        kind: proposal.kind,
        goal: requiredText(goal ?? proposal.goal, 'a goal', 4000),
        note: note.trim(),
        checkDate: optionalDate(checkDate === undefined ? proposal.checkDate : checkDate),
        merchantDeadline: null,
        status: 'open',
        owner: proposal.kind === 'refund' ? 'Shop' : null,
        evidence: []
      };
      const saved = database.prepare('INSERT OR IGNORE INTO errands VALUES (?, ?, ?)')
        .run(record.id, record.revision, JSON.stringify(record));
      if (saved.changes) return record;
      const existing = find(record.id);
      if (record.note !== existing.note || record.goal !== existing.goal || record.checkDate !== existing.checkDate) {
        throw new DeskError('This errand was already saved. Reload the desk to review it.', 409);
      }
      return existing;
    },
    edit(id, { goal, checkDate, revision }) {
      const errand = find(id);
      if (!Number.isInteger(revision)) throw new DeskError('An errand revision is required.');
      const record = {
        ...errand,
        revision: revision + 1,
        goal: requiredText(goal, 'a goal', 4000),
        checkDate: optionalDate(checkDate)
      };
      const update = database.prepare('UPDATE errands SET record = ?, revision = ? WHERE id = ? AND revision = ?')
        .run(JSON.stringify(record), record.revision, id, revision);
      if (!update.changes) throw new DeskError('This errand changed. Reload the desk before saving again.', 409);
      return record;
    },
    draft(id) {
      const errand = find(id);
      return {
        text: errand.kind === 'refund'
          ? 'Hello, could you check the status of the refund we discussed? Please let me know when it was issued and any reference I can use to find it. Thank you.'
          : `Hello, could you share an update on this? Thank you.\n\n${errand.goal}`
      };
    },
    inspect: () => ({ errands: list(), grants: [], effects: [] }),
    close: () => database.close()
  };
}
