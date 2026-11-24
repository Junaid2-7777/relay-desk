import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openActionJournal } from './action-journal.mjs';
import { orderChecks } from '../shared/brief-order.mjs';
import { activeGrant, makeGrant, sameInvoice, scopes, seedHousehold } from './household.mjs';
import { previewErrand, suggestPracticePlan } from './intake.mjs';
import { createIntakePlanner } from './intake-planner.mjs';
import { normalizeReceiptPlan, sameReceiptProof, sameReceiptScope } from './receipt.mjs';
import { receiptIdentifier } from './receipt-fixture.mjs';
import { checkRefund, refundGrant, refundSources } from './refund.mjs';
import { confirmVisitConflict } from './visit.mjs';

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

function visitTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
      !Number.isFinite(Date.parse(value))) throw new DeskError('Choose a valid start and end for the booking window.');
  optionalDate(value.slice(0, 10));
  return value;
}

const readErrand = row => row && JSON.parse(row.record);
const followupTerms = Object.freeze({
  recipient: 'returns@practice-shop.example',
  subject: 'Check on return-demo-1249'
});

export function openDesk({ dataDir, clock = () => new Date(), refundFixture, household, planner }) {
  const intakePlanner = household ? createIntakePlanner(planner) : undefined;
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, 'desk.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS errands (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      record TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS errand_saves (
      id TEXT PRIMARY KEY REFERENCES errands (id) ON DELETE CASCADE,
      intent TEXT NOT NULL
    ) STRICT;
  `);
  const get = database.prepare('SELECT record FROM errands WHERE id = ?');
  const getSave = database.prepare('SELECT record, intent FROM errands LEFT JOIN errand_saves USING (id) WHERE id = ?');
  const find = id => {
    const errand = readErrand(get.get(id));
    if (!errand) throw new DeskError('This errand could not be found.', 404);
    return errand;
  };
  const list = () => database.prepare('SELECT record FROM errands ORDER BY rowid DESC').all().map(readErrand);
  const today = () => localDay(clock());
  function fixedProposal(note, day, sources) {
    const parsed = previewErrand(note, day);
    return household ? { ...parsed, practicePlan: suggestPracticePlan(note, sources), plannerMode: 'fixed-rule' } : parsed;
  }
  const insert = database.prepare('INSERT OR IGNORE INTO errands VALUES (?, ?, ?)');
  const insertSave = database.prepare('INSERT INTO errand_saves VALUES (?, ?)');
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
    errands: orderChecks(list(), household),
    fixture: Boolean(refundFixture),
    household: Boolean(household),
    ...(household ? { receiptSources: household.receipt.fixture.sources(), plannerMode: intakePlanner.mode } : {})
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
    preview(input) {
      const note = requiredText(input, 'an errand', 4000);
      const day = today();
      const sources = household?.receipt.fixture.sources();
      const fixed = fixedProposal(note, day, sources);
      return intakePlanner ? intakePlanner.review(note, day, sources, fixed) : fixed;
    },
    save({ note: input, goal, checkDate, requestId, previewId }) {
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId))) {
        throw new DeskError('Use a valid save reference.');
      }
      const note = requiredText(input, 'an errand', 4000);
      const requestedGoal = goal == null ? undefined : requiredText(goal, 'a goal', 4000);
      const requestedDate = checkDate === undefined ? undefined : optionalDate(checkDate);
      const intent = requestId && createHash('sha256').update(JSON.stringify({
        note, goal: requestedGoal, checkDate: requestedDate, previewId
      })).digest('hex');
      const conflict = () => new DeskError('This errand was already saved. Reload the desk to review it.', 409);

      return transaction(() => {
        const previous = requestId ? getSave.get(requestId) : undefined;
        const existing = readErrand(previous);
        if (previous?.intent) {
          if (previous.intent !== intent) throw conflict();
          return existing;
        }

        const reviewed = previewId === undefined ? null : intakePlanner?.reviewed(previewId, note);
        if (previewId !== undefined && !reviewed && !existing) {
          throw new DeskError('This suggestion expired or the note changed. Review the note again.', 409);
        }
        const proposal = reviewed ?? (previewId !== undefined && existing ? existing :
          fixedProposal(note, today(), household?.receipt.fixture.sources()));
        const record = {
          id: requestId ?? randomUUID(),
          revision: 1,
          kind: proposal.kind,
          goal: requestedGoal ?? requiredText(proposal.goal, 'a goal', 4000),
          note,
          checkDate: requestedDate === undefined ? optionalDate(proposal.checkDate) : requestedDate,
          merchantDeadline: null,
          status: 'open',
          owner: proposal.kind === 'refund' ? 'Shop' : null,
          evidence: [],
          ...(household ? { practiceCase: true, practicePlan: proposal.practicePlan, plannerMode: proposal.plannerMode } : {})
        };

        // Older rows lack a saved request, so compare the fields still in the record.
        if (existing) {
          if (record.note !== existing.note || record.goal !== existing.goal || record.checkDate !== existing.checkDate ||
              (reviewed && existing.practicePlan !== undefined && (existing.plannerMode !== reviewed.plannerMode ||
                JSON.stringify(existing.practicePlan) !== JSON.stringify(reviewed.practicePlan)))) throw conflict();
          return existing;
        }

        if (!insert.run(record.id, record.revision, JSON.stringify(record)).changes) throw conflict();
        if (requestId) insertSave.run(record.id, intent);
        return record;
      });
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
          : `Hello, could you share an update on this? Thank you.\n\n${errand.goal}`,
        ...(household?.outbox && errand.refund && errand.status === 'open' && !errand.queuedFollowup ? followupTerms : {})
      };
    },
    queueFollowup(id, { revision, recipient, subject, text }) {
      const outbox = household?.outbox.fixture;
      if (!outbox || recipient !== followupTerms.recipient || subject !== followupTerms.subject ||
          typeof text !== 'string' || !text.trim() || text.length > 4000) {
        throw new DeskError('Review the exact practice recipient, subject and message.');
      }
      const terms = { recipient, subject, text };
      const key = 'followup-' + createHash('sha256').update(JSON.stringify([id, terms])).digest('hex');
      const record = find(id);
      if (!record.refund) throw new DeskError('This errand has no practice shop.', 404);
      const previous = journal.latest(id, 'followup');
      const existing = previous ? outbox.get(previous.key) : null;
      if (existing) {
        if (existing.key !== key) throw new DeskError('A follow-up is already queued for this return.', 409);
        journal.mark(key, 'committed');
        return changeCase(id, current => current.queuedFollowup ? current : { ...current, queuedFollowup: existing });
      }
      requireRevision(record, revision);
      if (record.status !== 'open') throw new DeskError('This refund no longer needs a follow-up.', 409);
      if (previous?.status === 'prepared' && previous.key !== key) {
        throw new DeskError('Retry the original draft before approving different text.', 409);
      }
      journal.prepare(id, 'followup', key, { key, ...terms });
      const result = journal.dispatch(id, (current, now) => {
        requireRevision(current, revision);
        return refundFixture.withinSnapshot(() => {
          const checked = checkRefund(current, refundFixture, now);
          const canQueue = checked.status === 'open' && checked.checks.credits?.status !== 'unavailable';
          const next = canQueue ? {
            ...checked,
            queuedFollowup: outbox.enqueue({ key, ...terms }, proposed =>
              proposed.key === key && proposed.recipient === recipient && proposed.subject === subject && proposed.text === text)
          } : checked;
          return next === current ? current : revise(next, current.revision);
        });
      });
      journal.mark(key, result.queuedFollowup ? 'committed' : 'blocked');
      return result;
    },
    refundAccess(id, { source, choice, revision }) {
      if (!refundSources.includes(source) || !['allowed', 'declined', 'withdrawn'].includes(choice)) {
        throw new DeskError('Choose a refund source and a permission.');
      }
      return withRefund(id, record => {
        requireRevision(record, revision);
        if (record.status === 'stopped' && choice === 'allowed') {
          throw new DeskError('Resume tracking before allowing access.', 409);
        }
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
        const resume = choice === 'resume';
        if (resume ? record.status !== 'stopped' : ['stopped', 'verified'].includes(record.status)) return record;
        const withdraw = grants => Object.fromEntries(Object.entries(grants).map(([source, grant]) =>
          [source, grant.status === 'allowed' ? { ...grant, status: 'withdrawn', revision: grant.revision + 1, expiresAt: null } : grant]));
        const { stoppedStatus, ...rest } = record;
        const withoutAccess = {
          ...rest,
          ...(record.grants ? { grants: withdraw(record.grants) } : {}),
          ...(record.refundAccess ? { refundAccess: withdraw(record.refundAccess) } : {}),
          ...(record.approval ? { approval: null } : {})
        };
        return resume
          ? { ...withoutAccess, status: stoppedStatus ?? 'open' }
          : { ...withoutAccess, status: 'stopped', stoppedStatus: record.status };
      });
    },
    setup(id, { revision, capability, issuer, subject, service, owner, type, status, windowStart, windowEnd }) {
      if (!household || !['receipt', 'visit'].includes(capability)) throw new DeskError('Choose a practice capability.');
      return changeCase(id, record => {
        requireRevision(record, revision);
        const editingReceipt = capability === 'receipt' && Boolean(record.receiptPlan);
        if (record.status !== 'open' || (!editingReceipt && !Object.hasOwn(record, 'practicePlan'))) {
          throw new DeskError('This errand cannot change its agreed plan.', 409);
        }
        const { practicePlan, ...existing } = record;
        if (capability === 'receipt') {
          const sources = household.receipt.fixture.sources();
          const receiptPlan = normalizeReceiptPlan({ issuer, subject, type, status }, sources);
          if (sameReceiptProof(record.receiptPlan, receiptPlan) && record.receiptPlan.available === receiptPlan.available) return record;
          const sameScope = sameReceiptScope(record.receiptPlan, receiptPlan);
          const previous = record.grants?.receipt;
          const grant = previous && !sameScope ? makeGrant('receipt', previous.scope, 'withdrawn', previous, clock()) : previous;
          const allowed = sameScope && activeGrant(grant, clock());
          return {
            ...existing,
            kind: 'receipt',
            owner: sources.find(source => source.issuer === receiptPlan.issuer)?.label ?? receiptPlan.issuer,
            receiptPlan,
            receiptCheck: sameScope ? record.receiptCheck ?? null : null,
            receiptProof: null,
            issue: receiptPlan.available ? (allowed ? 'receipt-pending' : 'receipt-permission') : 'evidence-needed',
            grants: grant ? { receipt: grant } : {}
          };
        }
        const visit = {
          issuer: receiptIdentifier(issuer, 'a provider identifier'),
          service: receiptIdentifier(service, 'a service identifier'),
          subject: receiptIdentifier(subject, 'a subject reference'),
          zone: 'Asia/Kolkata',
          windowStart: visitTime(windowStart),
          windowEnd: visitTime(windowEnd)
        };
        if (Date.parse(visit.windowStart) >= Date.parse(visit.windowEnd) || Date.parse(visit.windowEnd) <= +clock()) {
          throw new DeskError('Choose a booking window that ends in the future.');
        }
        return {
          ...existing,
          kind: 'visit',
          owner: owner ? requiredText(owner, 'a provider name', 100) : visit.issuer,
          visit,
          issue: 'visit-permission',
          grants: {}
        };
      });
    },
    householdAccess(id, { operation, choice, revision }) {
      if (!household || !['allowed', 'declined', 'withdrawn'].includes(choice)) {
        throw new DeskError('Choose a permission for the practice household.');
      }
      return changeCase(id, record => {
        requireRevision(record, revision);
        if (record.status === 'stopped' && choice === 'allowed') {
          throw new DeskError('Resume tracking before allowing access.', 409);
        }
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
        if (!record.bill || record.status !== 'open' || record.issue !== 'bill-review' || !activeGrant(record.grants.invoice, now)) {
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
    visitChoice(id, { choice, revision }) {
      if (!household || !['handle', 'watch'].includes(choice)) throw new DeskError('Choose how to handle the calendar conflict.');
      return changeCase(id, record => {
        requireRevision(record, revision);
        const conflict = confirmVisitConflict(record, household.visit.fixture, journal, clock);
        if (!conflict) throw new DeskError('The calendar conflict could not be confirmed. Check your errands and permissions.', 409);
        const conflictChoice = { choice, ...conflict };
        const previous = record.conflictChoice;
        if (previous?.choice === choice && previous.reservationId === conflict.reservationId &&
            previous.start === conflict.start && previous.end === conflict.end) return record;
        return { ...record, conflictChoice };
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
          } else if (record.bill || record.visit || record.receiptPlan) {
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
      return transaction(() => {
        journal.reset(record.id);
        return seed(record);
      });
    },
    resetHousehold(warm) {
      transaction(() => {
        const extras = list().filter(record => record.practiceCase);
        const remove = database.prepare('DELETE FROM errands WHERE id = ?');
        for (const record of extras) {
          journal.reset(record.id);
          remove.run(record.id);
        }
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
