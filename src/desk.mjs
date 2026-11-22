import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openActionJournal } from './action-journal.mjs';
import { activeGrant, makeGrant, orderBrief, sameInvoice, scopes, seedHousehold } from './household.mjs';
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

function checkpointReference(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && /^[\w.-]{1,100}$/.test(value)) return value;
  throw new DeskError('Use a valid check reference.');
}

const readErrand = row => row && JSON.parse(row.record);

export function openDesk({ dataDir, clock = () => new Date(), refundFixture, household }) {
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
  function changeCase(id, action) {
    return transaction(() => {
      const record = find(id);
      const next = action(record);
      return next === record ? record : revise(next, record.revision);
    });
  }
  function withRefund(id, action) {
    return changeCase(id, record => {
      if (!refundFixture || record.refund?.reference !== refundFixture.subject.reference) {
        throw new DeskError('This errand has no connected refund source.', 404);
      }
      return action(record);
    });
  }
  function requireRevision(record, revision) {
    if (record.revision !== revision) {
      throw new DeskError('This errand changed. Reload the desk before saving again.', 409);
    }
  }
  const journal = openActionJournal(database, find, transaction, clock);
  const brief = () => ({
    today: today(),
    now: clock().toISOString(),
    errands: household ? orderBrief(list()) : list(),
    fixture: Boolean(refundFixture),
    household: Boolean(household)
  });
  const updateRefund = (id, reference) => {
    const checkpointId = checkpointReference(reference);
    return withRefund(id, record =>
      ['verified', 'stopped'].includes(record.status) ? record : checkRefund(record, refundFixture, clock(), checkpointId));
  };
  function seed(record) {
    const existing = readErrand(get.get(record.id));
    if (existing) return revise(record, existing.revision);
    insert.run(record.id, record.revision, JSON.stringify(record));
    return record;
  }

  return {
    brief,
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
        requireRevision(record, revision);
        const previous = record.refundAccess[source];
        const grant = refundGrant(refundFixture.subject, source, choice, previous, clock());
        return { ...record, refundAccess: { ...record.refundAccess, [source]: grant } };
      });
    },
    checkRefund: updateRefund,
    tracking(id, { choice, revision }) {
      if (!['stop', 'resume'].includes(choice)) throw new DeskError('Choose whether to track this errand.');
      return changeCase(id, record => {
        requireRevision(record, revision);
        if (choice === 'resume') {
          if (record.status !== 'stopped') return record;
          const { stoppedStatus, ...rest } = record;
          return { ...rest, status: stoppedStatus ?? 'open' };
        }
        if (record.status === 'stopped' || record.status === 'verified') return record;
        const withdraw = grants => Object.fromEntries(Object.entries(grants).map(([source, grant]) =>
          [source, grant.status === 'allowed' ? { ...grant, status: 'withdrawn', revision: grant.revision + 1, expiresAt: null } : grant]));
        return {
          ...record,
          stoppedStatus: record.status,
          status: 'stopped',
          ...(record.grants ? { grants: withdraw(record.grants) } : {}),
          ...(record.refundAccess ? { refundAccess: withdraw(record.refundAccess) } : {}),
          ...(record.approval ? { approval: null } : {})
        };
      });
    },
    householdAccess(id, { operation, choice, revision }) {
      if (!household || !['allowed', 'declined', 'withdrawn'].includes(choice)) {
        throw new DeskError('Choose a permission for the practice household.');
      }
      return changeCase(id, record => {
        requireRevision(record, revision);
        const offered = scopes(record);
        if (!Object.hasOwn(offered, operation)) throw new DeskError('This errand has no such permission.');
        const grant = makeGrant(operation, offered[operation], choice, record.grants[operation], clock());
        return { ...record, grants: { ...record.grants, [operation]: grant } };
      });
    },
    billChoice(id, { choice, revision }) {
      if (!household || !['approve', 'defer'].includes(choice)) throw new DeskError('Choose what to do with the invoice.');
      return changeCase(id, record => {
        requireRevision(record, revision);
        const now = clock();
        if (!record.bill || record.issue !== 'bill-review' || !activeGrant(record.grants.invoice, now)) {
          throw new DeskError('There is no invoice ready for review.', 409);
        }
        const invoice = household.bill.fixture.readInvoice(record.bill.invoiceId);
        if (!sameInvoice(invoice, record.invoice)) throw new DeskError('The invoice changed. Check your errands to see the new terms.', 409);
        if (choice === 'defer') return { ...record, approval: null, deferred: invoice, issue: 'bill-deferred' };
        if (!activeGrant(record.grants.payment, now) || invoice.payee !== record.bill.payee ||
            invoice.currency !== record.bill.currency) {
          throw new DeskError('This invoice needs a separate payment permission.', 409);
        }
        const { invoiceId, revision: invoiceRevision, payee, amountMinor, currency } = invoice;
        return {
          ...record,
          approval: {
            invoiceId,
            revision: invoiceRevision,
            payee,
            amountMinor,
            currency,
            status: 'allowed',
            expiresAt: new Date(+now + 15 * 60 * 1000).toISOString(),
            grantRevision: record.grants.payment.revision
          },
          deferred: null
        };
      });
    },
    checkpoint(reference) {
      const checkpointId = checkpointReference(reference);
      if (!household) throw new DeskError('The practice household could not be found.', 404);
      const conflicts = [];
      for (const record of list()) {
        try {
          if (record.refund) {
            updateRefund(record.id, checkpointId);
          } else if (record.bill || record.visit) {
            const { run, fixture } = household[record.kind];
            const next = run(record, fixture, journal, clock());
            if (JSON.stringify(next) !== JSON.stringify(record)) revise(next, record.revision);
          }
        } catch (error) {
          if (error.code !== 'operation-pending' && (!(error instanceof DeskError) || error.status !== 409)) throw error;
          conflicts.push(record.id);
        }
      }
      return { ...brief(), conflicts };
    },
    resetRefund(warm = false) {
      const { reference, amountMinor, currency } = refundFixture.subject;
      const record = {
        id: 'demo-refund',
        revision: 1,
        kind: 'refund',
        goal: 'Check for my ₹1,249 refund',
        note: 'The shop promised a refund for my return. Help me check for the credit on Friday.',
        checkDate: '2026-11-27',
        merchantDeadline: null,
        status: 'open',
        owner: 'Demo shop',
        refund: { reference, amountMinor, currency },
        refundAccess: warm
          ? Object.fromEntries(refundSources.map(source => [source, refundGrant(refundFixture.subject, source, 'allowed', null, clock())]))
          : {},
        checks: {},
        evidence: []
      };
      return seed(record);
    },
    resetHousehold(warm) {
      transaction(() => {
        for (const record of seedHousehold(clock(), warm)) {
          journal.reset(record.id);
          seed(record);
        }
      });
    },
    inspect() {
      const errands = list();
      return {
        errands,
        grants: errands.flatMap(record =>
          Object.values(record.refundAccess ?? record.grants ?? {}).map(grant => ({ errandId: record.id, ...grant }))),
        effects: refundFixture?.inspect().reads ?? [],
        ...(household ? { actions: journal.inspect() } : {})
      };
    },
    close: () => database.close()
  };
}
