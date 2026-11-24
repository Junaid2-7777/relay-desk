import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { kolkataDay as localDay, zonedInstant } from '../shared/evidence-time.mjs';
import { openActionJournal } from './action-journal.mjs';
import { invoiceGrant } from './bill.mjs';
import { orderChecks } from '../shared/brief-order.mjs';
import { activeGrant, makeGrant, sameInvoice, scopes, seedHousehold } from './household.mjs';
import { previewErrand, suggestPracticePlan } from './intake.mjs';
import { createIntakePlanner } from './intake-planner.mjs';
import { normalizeReceiptPlan, sameReceiptProof, sameReceiptScope } from './receipt.mjs';
import { receiptIdentifier } from './receipt-fixture.mjs';
import { checkRefund, refundGrant, refundSources } from './refund.mjs';
import { confirmVisitConflict } from './visit.mjs';

export class DeskError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export { localDay };

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
  if (!Number.isFinite(zonedInstant(value))) throw new DeskError('Choose a valid start and end for the booking window.');
  return value;
}

function sameVisitScope(left, right) {
  return left?.issuer === right.issuer && left.service === right.service && left.subject === right.subject &&
    left.zone === right.zone && Date.parse(left.windowStart) === Date.parse(right.windowStart) &&
    Date.parse(left.windowEnd) === Date.parse(right.windowEnd);
}

const readErrand = row => row && JSON.parse(row.record);
const changedContextCode = 'desk-context-changed';
const maximumLocalDraftLength = 8000;
const followupTerms = Object.freeze({
  recipient: 'returns@practice-shop.example',
  subject: 'Check on return-demo-1249'
});

export function openDesk({ dataDir, clock = () => new Date(), refundFixture, household, planner }) {
  const candidate = typeof planner?.propose === 'function' ? {
    mode: planner.mode,
    timeoutMs: planner.timeoutMs,
    propose(input) {
      let pending;
      readWithContext(() => { pending = planner.propose(input); });
      return pending;
    }
  } : planner;
  const intakePlanner = household ? createIntakePlanner(candidate) : undefined;
  mkdirSync(dataDir, { recursive: true });
  const directory = realpathSync(dataDir);
  const database = new DatabaseSync(join(directory, 'desk.sqlite'));
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
    CREATE TABLE IF NOT EXISTS local_drafts (
      errandId TEXT PRIMARY KEY REFERENCES errands (id) ON DELETE CASCADE,
      draftRevision INTEGER NOT NULL CHECK (draftRevision > 0),
      text TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS receipt_checkpoints (
      errandId TEXT NOT NULL REFERENCES errands(id) ON DELETE CASCADE,
      checkpointId TEXT NOT NULL,
      PRIMARY KEY (errandId, checkpointId)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS desk_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      id TEXT NOT NULL,
      resetVersion INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS practice_reset (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      role TEXT NOT NULL
    ) STRICT;
  `);
  database.prepare('INSERT INTO desk_identity (singleton, id) VALUES (1, ?) ON CONFLICT (singleton) DO NOTHING').run(randomUUID());
  const readIdentity = database.prepare(`
    SELECT id, resetVersion, practice_reset.role AS resetting FROM desk_identity
    LEFT JOIN practice_reset USING (singleton) WHERE desk_identity.singleton = 1
  `);
  const rotateContext = database.prepare('UPDATE desk_identity SET resetVersion = resetVersion + 1 WHERE singleton = 1');
  const startReset = database.prepare('INSERT OR REPLACE INTO practice_reset VALUES (1, ?)');
  const finishReset = database.prepare('DELETE FROM practice_reset WHERE singleton = 1');
  const role = household ? 'household' : refundFixture ? 'refund-practice' : 'private';
  const practice = role !== 'private';
  // Earlier builds marked household intake with practiceCase and used fixed IDs for the three seeds.
  // Unmarked notes belong to the private desk, including notes already saved in a mixed directory.
  database.exec(`
    CREATE TEMP VIEW visible_errands AS SELECT rowid AS savedOrder, id, record FROM errands
    WHERE (id IN ('demo-refund', 'demo-visit', 'demo-bill') OR COALESCE(json_extract(record, '$.practiceCase'), 0) = 1)
      = ${practice ? 1 : 0}
  `);
  const requestContext = new AsyncLocalStorage();
  const deskContext = ({ id, resetVersion } = readIdentity.get()) => {
    return createHash('sha256').update(JSON.stringify([id, practice ? resetVersion : 0, directory, role, intakePlanner?.mode ?? 'fixed-rule'])).digest('hex');
  };
  const resetIncomplete = () => new DeskError('The practice reset is unfinished. If it was interrupted, run npm run reset again and reload.', 503, 'practice-reset-incomplete');
  function checkDeskContext() {
    const request = requestContext.getStore();
    if (!practice && request?.expected === undefined) return;
    const identity = readIdentity.get();
    if (practice && identity.resetting) throw resetIncomplete();
    if (!request) return;
    const current = deskContext(identity);
    if (practice) request.expected ??= current;
    if (request.expected !== current) {
      throw new DeskError('The desk changed. Reload the page before continuing.', 409, changedContextCode);
    }
  }
  const get = database.prepare('SELECT record FROM visible_errands WHERE id = ?');
  const getSave = database.prepare('SELECT record, intent FROM visible_errands LEFT JOIN errand_saves USING (id) WHERE id = ?');
  const find = id => {
    const errand = readErrand(get.get(id));
    if (!errand) throw new DeskError('This errand could not be found.', 404);
    return errand;
  };
  const visible = database.prepare('SELECT record FROM visible_errands ORDER BY savedOrder DESC');
  const list = () => visible.all().map(readErrand);
  const today = () => localDay(clock());
  function fixedProposal(note, day, sources) {
    const parsed = previewErrand(note, day);
    return household ? { ...parsed, practicePlan: suggestPracticePlan(note, sources), plannerMode: 'fixed-rule' } : parsed;
  }
  const insert = database.prepare('INSERT OR IGNORE INTO errands VALUES (?, ?, ?)');
  const insertSave = database.prepare('INSERT INTO errand_saves VALUES (?, ?)');
  const readLocalDraft = database.prepare('SELECT text, draftRevision FROM local_drafts WHERE errandId = ?');
  const writeLocalDraft = database.prepare(`
    INSERT INTO local_drafts (errandId, draftRevision, text) VALUES (?, ?, ?)
    ON CONFLICT (errandId) DO UPDATE SET draftRevision = excluded.draftRevision, text = excluded.text
  `);
  const seenReceiptCheck = database.prepare('SELECT 1 FROM receipt_checkpoints WHERE errandId = ? AND checkpointId = ?');
  const rememberReceiptCheck = database.prepare('INSERT INTO receipt_checkpoints VALUES (?, ?)');
  const update = database.prepare('UPDATE errands SET record = ?, revision = ? WHERE id = ? AND revision = ?');
  let transactionOpen = false;
  function revise(record, revision) {
    return write(() => {
      const next = { ...record, revision: revision + 1 };
      if (!update.run(JSON.stringify(next), next.revision, next.id, revision).changes) {
        throw new DeskError('This errand changed. Reload the desk before saving again.', 409);
      }
      return next;
    });
  }
  function transaction(action, { recovery = false } = {}) {
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    try {
      if (!recovery) checkDeskContext();
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      transactionOpen = false;
    }
  }
  const write = action => transactionOpen ? action() : transaction(action);
  const readWithContext = read => practice || requestContext.getStore()?.expected !== undefined ? write(read) : read();
  function changeCase(id, action) {
    return transaction(() => {
      const record = find(id);
      const next = action(record);
      return projectErrand(next === record ? record : revise(next, record.revision));
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
  const journal = openActionJournal(database, find, transaction, clock, write);
  function canEditVisit(record) {
    return Boolean(record.practiceCase && record.visit && record.status === 'open' &&
      !record.reservation && !record.calendarEvent && record.issue !== 'reservation-unknown' &&
      !journal.latest(record.id, 'reserve') && !journal.latest(record.id, 'calendar'));
  }
  function projectErrand(record) {
    return household && record.practiceCase && record.visit ? { ...record, visitPlanEditable: canEditVisit(record) } : record;
  }
  function pendingFollowup(record) {
    if (!household?.outbox || !record.refund || record.queuedFollowup ||
        record.refund.reference !== refundFixture?.subject.reference) return null;
    const action = journal.latest(record.id, 'followup');
    return ['prepared', 'unknown', 'committed'].includes(action?.status) ? action.payload : null;
  }
  const brief = () => {
    const now = clock();
    return {
      deskContext: deskContext(),
      today: localDay(now),
      now: now.toISOString(),
      errands: orderChecks(list().map(record => pendingFollowup(record) ? { ...record, pendingFollowup: true } : projectErrand(record)), household, now),
      fixture: Boolean(refundFixture),
      household: Boolean(household),
      ...(household ? { receiptSources: household.receipt.fixture.sources(), plannerMode: intakePlanner.mode } : {})
    };
  };
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

  function resetCases(reset) {
    return transaction(() => {
      const result = reset();
      rotateContext.run();
      return result;
    });
  }

  function resetRefundCase(warm) {
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
    journal.reset(record.id);
    return seed(record);
  }

  function resetHouseholdCases(warm) {
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
  }

  return {
    brief,
    deskContext,
    checkDeskContext,
    readWithContext,
    withDeskContext: (expected, action) => requestContext.run({ expected }, action),
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
          return projectErrand(existing);
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
          ...(practice ? { practiceCase: true } : {}),
          ...(household ? { practicePlan: proposal.practicePlan, plannerMode: proposal.plannerMode } : {})
        };

        // Older rows lack a saved request, so compare the fields still in the record.
        if (existing) {
          if (record.note !== existing.note || record.goal !== existing.goal || record.checkDate !== existing.checkDate ||
              (reviewed && existing.practicePlan !== undefined && (existing.plannerMode !== reviewed.plannerMode ||
                JSON.stringify(existing.practicePlan) !== JSON.stringify(reviewed.practicePlan)))) throw conflict();
          return projectErrand(existing);
        }

        if (!insert.run(record.id, record.revision, JSON.stringify(record)).changes) throw conflict();
        if (requestId) insertSave.run(record.id, intent);
        return record;
      });
    },
    edit(id, { goal, checkDate, revision }) {
      const errand = find(id);
      if (!Number.isInteger(revision)) throw new DeskError('An errand revision is required.');
      return projectErrand(revise({
        ...errand,
        goal: requiredText(goal, 'a goal', 4000),
        checkDate: optionalDate(checkDate)
      }, revision));
    },
    draft(id) {
      const errand = find(id);
      const saved = !practice && readLocalDraft.get(id);
      if (saved) return { ...saved };
      const pending = pendingFollowup(errand);
      if (pending) {
        const { recipient, subject, text } = pending;
        return { recipient, subject, text, pendingFollowup: true };
      }
      return {
        text: errand.kind === 'refund'
          ? 'Hello, could you check the status of the refund we discussed? Please let me know when it was issued and any reference I can use to find it. Thank you.'
          : `Hello, could you share an update on this? Thank you.\n\n${errand.goal}`,
        ...(!practice ? { draftRevision: 0 } : {}),
        ...(household?.outbox && errand.refund && errand.status === 'open' && !errand.queuedFollowup ? followupTerms : {})
      };
    },
    saveLocalDraft(id, { text, draftRevision }) {
      if (practice) throw new DeskError('Local draft saving is available in the private desk.', 404);
      if (typeof text !== 'string' || !text.trim() || text.length > maximumLocalDraftLength) {
        throw new DeskError(`Enter a draft of up to ${maximumLocalDraftLength} characters.`);
      }
      if (!Number.isSafeInteger(draftRevision) || draftRevision < 0) throw new DeskError('Use a valid draft revision.');
      return transaction(() => {
        find(id);
        const previous = readLocalDraft.get(id);
        const revision = previous?.draftRevision ?? 0;
        if (previous?.text === text && (draftRevision === revision || draftRevision === revision - 1)) return { ...previous };
        if (draftRevision !== revision) {
          throw new DeskError('The saved draft changed. Reopen it before saving a new copy.', 409, 'local-draft-conflict');
        }
        const saved = { text, draftRevision: revision + 1 };
        writeLocalDraft.run(id, saved.draftRevision, saved.text);
        return saved;
      });
    },
    queueFollowup(id, { revision, recipient, subject, text, reconcileOnly = false }) {
      const outbox = household?.outbox.fixture;
      if (!outbox || !refundFixture || typeof reconcileOnly !== 'boolean' ||
          recipient !== followupTerms.recipient || subject !== followupTerms.subject ||
          typeof text !== 'string' || !text.trim() || text.length > 4000) {
        throw new DeskError('Review the exact practice recipient, subject and message.');
      }
      const terms = { recipient, subject, text };
      const key = 'followup-' + createHash('sha256').update(JSON.stringify([id, terms])).digest('hex');
      const intent = { key, ...terms };
      const unconfirmed = () => new DeskError('The practice outbox could not confirm the queue. Retry the original draft.', 409);
      const exactTerms = (message, request) => message?.key === request.key && message.recipient === request.recipient &&
        message.subject === request.subject && message.text === request.text;
      function readback(request) {
        let message;
        try {
          message = outbox.get(request.key);
        } catch {
          return undefined;
        }
        if (message === null) return null;
        if (!exactTerms(message, request) || message.status !== 'queued' || typeof message.queuedAt !== 'string') return undefined;
        const queuedAt = new Date(message.queuedAt);
        return Number.isFinite(+queuedAt) && queuedAt.toISOString() === message.queuedAt
          ? { ...request, status: 'queued', queuedAt: message.queuedAt } : undefined;
      }
      function recover(current, previous) {
        if (!previous) return current.queuedFollowup ? undefined : null;
        const queued = readback(previous.payload);
        if (!queued) {
          if (queued === null && previous.status !== 'committed' && !current.queuedFollowup) return null;
          journal.mark(previous.key, 'unknown');
          return undefined;
        }
        journal.mark(previous.key, 'committed');
        return exactTerms(current.queuedFollowup, queued) && current.queuedFollowup.status === queued.status &&
          current.queuedFollowup.queuedAt === queued.queuedAt
          ? current : revise({ ...current, queuedFollowup: queued }, current.revision);
      }
      function verifyResult(result) {
        if (!result) throw unconfirmed();
        if (result.queuedFollowup && result.queuedFollowup.key !== key) {
          throw new DeskError('A follow-up is already queued for this return.', 409);
        }
        return result;
      }
      function requireOpen(current) {
        requireRevision(current, revision);
        if (current.status !== 'open') throw new DeskError('This refund no longer needs a follow-up.', 409);
      }

      const existing = journal.dispatch(id, current => {
        if (current.refund?.reference !== refundFixture.subject.reference) {
          throw new DeskError('This errand has no practice shop.', 404);
        }
        const previous = journal.latest(id, 'followup');
        if (reconcileOnly && !exactTerms(previous?.payload, intent)) {
          throw new DeskError('Review the original approved draft before checking the practice outbox.', 409);
        }
        const recovered = recover(current, previous);
        if (recovered !== null) return recovered;
        if (reconcileOnly) {
          journal.mark(previous.key, 'blocked');
          return { ...current, pendingFollowup: false, followupReconciliation: 'not-queued' };
        }
        requireOpen(current);
        if (previous) journal.mark(previous.key, 'blocked');
        return null;
      });
      if (existing !== null) return verifyResult(existing);
      try {
        journal.prepare(id, 'followup', key, intent);
      } catch (error) {
        if (error.code === 'operation-pending') throw unconfirmed();
        throw error;
      }
      const result = journal.dispatch(id, (current, _now, readClock) => {
        const active = journal.latest(id, 'followup');
        if (active?.key !== key || active.status !== 'prepared') return recover(current, active);
        requireOpen(current);
        return refundFixture.withinSnapshot(() => {
          const checked = checkRefund(current, refundFixture, readClock());
          const creditCheck = checked.checks?.credits;
          const creditUnavailable = creditCheck !== current.checks?.credits && creditCheck?.status === 'unavailable';
          if (checked.status !== 'open' || creditUnavailable) {
            journal.mark(key, 'blocked');
            return checked === current ? current : revise(checked, current.revision);
          }
          try {
            outbox.enqueue(intent, proposed => exactTerms(proposed, intent));
          } catch {
            // An error can arrive after the provider commits. Only its native readback settles the queue outcome.
          }
          const queued = readback(intent);
          journal.mark(key, queued ? 'committed' : 'unknown');
          return queued ? revise({ ...checked, queuedFollowup: queued }, current.revision) : undefined;
        });
      });
      return verifyResult(result);
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
        const editingReceipt = capability === 'receipt' && Boolean(record.receiptPlan) && !record.visit;
        const editingVisit = capability === 'visit' && canEditVisit(record);
        const firstPlan = !record.visit && !record.receiptPlan && Object.hasOwn(record, 'practicePlan');
        if (record.status !== 'open' || (!editingReceipt && !editingVisit && !firstPlan)) {
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
        const currentLabel = editingVisit && record.visit.issuer === visit.issuer ? record.owner : visit.issuer;
        const label = owner ? requiredText(owner, 'a provider name', 100) : currentLabel;
        if (editingVisit && sameVisitScope(record.visit, visit)) return record.owner === label ? record : { ...record, owner: label };
        const now = clock();
        if (Date.parse(visit.windowStart) >= Date.parse(visit.windowEnd) || Date.parse(visit.windowEnd) <= +now) {
          throw new DeskError('Choose a booking window that ends in the future.');
        }
        const previousGrants = editingVisit ? record.grants : {};
        const grants = Object.fromEntries(Object.entries(previousGrants ?? {}).map(([operation, grant]) => [
          operation, grant.status === 'withdrawn' ? grant : makeGrant(operation, grant.scope, 'withdrawn', grant, now)
        ]));
        return {
          ...existing,
          kind: 'visit',
          owner: label,
          visit,
          issue: 'visit-permission',
          grants
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
        if (!record.bill || record.status !== 'open' || record.issue !== 'bill-review' || !invoiceGrant(record, record.bill, now)) {
          throw new DeskError('There is no invoice ready for review.', 409);
        }
        const invoice = household.bill.fixture.readInvoice(record.bill.invoiceId, at => invoiceGrant(record, record.bill, at));
        if (invoice === undefined) throw new DeskError('Invoice access expired. Review access before checking again.', 409);
        if (!sameInvoice(invoice, record.invoice)) throw new DeskError('The invoice changed. Check your errands to see the new terms.', 409);
        if (choice === 'defer') return { ...record, approval: null, deferred: invoice, issue: 'bill-deferred' };
        const approvalTime = clock();
        if (!activeGrant(record.grants.payment, approvalTime) || invoice.payee !== record.bill.payee ||
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
            expiresAt: new Date(+approvalTime + 15 * 60 * 1000).toISOString(),
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
          } else if (record.receiptPlan) {
            changeCase(record.id, current => {
              if (checkpointId && seenReceiptCheck.get(current.id, checkpointId)) return current;
              const next = household.receipt.run(current, household.receipt.fixture, clock, checkpointId);
              if (checkpointId && current.status === 'open') rememberReceiptCheck.run(current.id, checkpointId);
              return JSON.stringify(next) === JSON.stringify(current) ? current : next;
            });
          } else if (record.bill || record.visit) {
            const { run, fixture } = household[record.kind];
            const next = run(record, fixture, journal, clock());
            if (JSON.stringify(next) !== JSON.stringify(record)) revise(next, record.revision);
          }
        } catch (error) {
          if (error.code === changedContextCode ||
              (error.code !== 'operation-pending' && (!(error instanceof DeskError) || error.status !== 409))) throw error;
          conflicts.push(record.id);
        }
      }
      return { ...readWithContext(brief), conflicts };
    },
    resetRefund: (warm = false) => resetCases(() => resetRefundCase(warm)),
    resetHousehold: warm => resetCases(() => resetHouseholdCases(warm)),
    resetPractice(warm, resetProviders) {
      if (!practice) throw new DeskError('Only the practice desk can reset practice data.');
      // Each provider commits independently. Keep recovery pending across process exits
      // until both the provider resets and the desk reseed have finished.
      const version = transaction(() => {
        if (readIdentity.get().resetting === 'household' && !household) throw resetIncomplete();
        startReset.run(role);
        rotateContext.run();
        return readIdentity.get().resetVersion;
      }, { recovery: true });
      return transaction(() => {
        if (readIdentity.get().resetVersion !== version) {
          throw new DeskError('A newer practice reset took over.', 409, changedContextCode);
        }
        resetProviders();
        resetRefundCase(Boolean(household && warm));
        if (household) resetHouseholdCases(warm);
        finishReset.run();
      }, { recovery: true });
    },
    inspect() {
      const errands = list();
      const ids = new Set(errands.map(record => record.id));
      return {
        errands,
        grants: errands.flatMap(record =>
          Object.values(record.refundAccess ?? record.grants ?? {}).map(grant => ({ errandId: record.id, ...grant }))),
        effects: refundFixture?.inspect().reads ?? [],
        ...(household ? { actions: journal.inspect().filter(action => ids.has(action.errandId)) } : {})
      };
    },
    close: () => database.close()
  };
}
