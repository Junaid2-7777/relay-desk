import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { previewErrand } from './intake.mjs';
import { checkRefund, refundGrant, refundSources } from './refund.mjs';

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

export function openDesk({ dataDir, clock = () => new Date(), refundFixture }) {
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
  const insert = database.prepare('INSERT OR IGNORE INTO errands VALUES (?, ?, ?)');
  const update = database.prepare('UPDATE errands SET record = ?, revision = ? WHERE id = ? AND revision = ?');
  function revise(record, revision) {
    const next = { ...record, revision: revision + 1 };
    if (!update.run(JSON.stringify(next), next.revision, next.id, revision).changes) {
      throw new DeskError('This errand changed. Reload the desk before saving again.', 409);
    }
    return next;
  }
  function withRefund(id, action) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const record = find(id);
      if (!refundFixture || record.refund?.reference !== refundFixture.subject.reference) {
        throw new DeskError('This errand has no connected refund source.', 404);
      }
      const next = action(record);
      const result = next === record ? record : revise(next, record.revision);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    brief: () => ({ today: today(), now: clock().toISOString(), errands: list(), fixture: Boolean(refundFixture) }),
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
      const saved = insert.run(record.id, record.revision, JSON.stringify(record));
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
      return revise({
        ...errand,
        goal: requiredText(goal, 'a goal', 4000),
        checkDate: optionalDate(checkDate)
      }, revision);
    },
    draft(id) {
      const errand = find(id);
      return {
        text: errand.kind === 'refund'
          ? 'Hello, could you check the status of the refund we discussed? Please let me know when it was issued and any reference I can use to find it. Thank you.'
          : `Hello, could you share an update on this? Thank you.\n\n${errand.goal}`
      };
    },
    refundAccess(id, { source, choice, revision }) {
      if (!refundSources.includes(source) || !['allowed', 'declined', 'withdrawn'].includes(choice)) {
        throw new DeskError('Choose a refund source and a permission.');
      }
      return withRefund(id, record => {
        if (record.revision !== revision) {
          throw new DeskError('This errand changed. Reload the desk before saving again.', 409);
        }
        const previous = record.refundAccess[source];
        const grant = refundGrant(refundFixture.subject, source, choice, previous, clock());
        return { ...record, refundAccess: { ...record.refundAccess, [source]: grant } };
      });
    },
    checkRefund(id) {
      return withRefund(id, record => record.status === 'verified' ? record : checkRefund(record, refundFixture, clock()));
    },
    resetRefund() {
      const id = 'demo-refund';
      const { reference, amountMinor, currency } = refundFixture.subject;
      const record = {
        id,
        revision: 1,
        kind: 'refund',
        goal: 'Check for my ₹1,249 refund',
        note: 'The shop promised a refund for my return. Help me check for the credit on Friday.',
        checkDate: '2026-11-27',
        merchantDeadline: null,
        status: 'open',
        owner: 'Demo shop',
        refund: { reference, amountMinor, currency },
        refundAccess: {},
        checks: {},
        evidence: []
      };
      const existing = readErrand(get.get(id));
      if (existing) return revise(record, existing.revision);
      insert.run(id, record.revision, JSON.stringify(record));
      return record;
    },
    inspect() {
      const errands = list();
      return {
        errands,
        grants: errands.flatMap(record => Object.values(record.refundAccess ?? {}).map(grant => ({ errandId: record.id, ...grant }))),
        effects: refundFixture?.inspect().reads ?? []
      };
    },
    close: () => database.close()
  };
}
