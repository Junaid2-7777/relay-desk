import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { reviewNeeded } from '../shared/brief-order.mjs';
import { openBillFixture } from '../src/bill-fixture.mjs';
import { openOutboxFixture } from '../src/outbox-fixture.mjs';
import { isReceiptIdentifier, openReceiptFixture } from '../src/receipt-fixture.mjs';
import { createRecordedPlanner } from '../src/recorded-planner.mjs';
import { openRefundFixture } from '../src/refund-fixture.mjs';
import { createDeskServer } from '../src/server.mjs';
import { openVisitFixture } from '../src/visit-fixture.mjs';
import {
  auditedEffectCounts, defaultTrialTime, fullAudit, isZonedTimestamp, redactHeldOut, reviewHeldOutAudit,
  summarizeHeldOut, validateHeldOutManifest, validateTrialClock, visitChoices
} from './held-out-rubric.mjs';

const root = new URL('../', import.meta.url);
const defaultCases = new URL('fixtures/planner-rehearsal.json', root);
const httpTimeoutMs = 5000;
const trialCount = 3;
const modes = ['fixed-rule', 'recorded-response'];
const providerFactories = {
  bill: openBillFixture,
  outbox: openOutboxFixture,
  receipt: openReceiptFixture,
  refund: openRefundFixture,
  visit: openVisitFixture
};
const eventMethods = {
  bill: ['putInvoice', 'putSettlement', 'failNextReply'],
  receipt: ['putSource', 'putReceipt', 'setAvailable'],
  refund: ['putEvent', 'putCredit', 'putLink', 'setAvailable'],
  visit: ['putSlot', 'putCalendarEvent', 'failNextReservationReply', 'failNextCalendarWrite', 'failNextCalendarReply']
};
const zeroEffects = { reservations: 0, calendarWrites: 0, payments: 0, queuedMessages: 0 };
const billSubjectFields = ['invoiceId', 'payee', 'currency'];
const paymentFields = [...billSubjectFields, 'revision', 'amountMinor'];
const receiptFields = ['id', 'issuer', 'subject', 'type', 'status', 'occurredAt'];
const bookingFields = ['issuer', 'service', 'subject', 'zone'];
const bookingGrantFields = [...bookingFields, 'windowStart', 'windowEnd'];
const calendarFields = ['id', 'reservationId', 'start', 'end', 'zone'];
const paymentGrantFields = ['payee', 'currency'];
const standingGrantDuration = 7 * 24 * 60 * 60 * 1000;
const billApprovalDuration = 15 * 60 * 1000;

const sameFields = (left, right, fields) => Boolean(left && right && fields.every(field =>
  Object.hasOwn(left, field) && Object.hasOwn(right, field) && left[field] === right[field]));
const pickFields = (record, fields) => Object.fromEntries(fields.map(field => [field, record[field]]));
const hasRead = (provider, source, scope) => provider.reads.some(read =>
  read.source === source && !read.unavailable && isDeepStrictEqual(read.scope, scope));
function active(grant, now, lifetime = standingGrantDuration) {
  if (grant?.status !== 'allowed' || !isZonedTimestamp(grant.expiresAt) || !isZonedTimestamp(now)) return false;
  const instant = Date.parse(now);
  const expiry = Date.parse(grant.expiresAt);
  return instant >= expiry - lifetime && instant < expiry;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const duration = start => Math.round(performance.now() - start);

function difference(observed, expected, path, mismatches = []) {
  if (Array.isArray(expected) && Array.isArray(observed)) {
    difference(observed.length, expected.length, `${path}.length`, mismatches);
    for (const [index, item] of expected.entries()) difference(observed[index], item, `${path}[${index}]`, mismatches);
  } else if (expected && typeof expected === 'object' && !Array.isArray(expected) &&
             observed && typeof observed === 'object' && !Array.isArray(observed)) {
    for (const [key, value] of Object.entries(expected)) difference(observed[key], value, `${path}.${key}`, mismatches);
  } else if (!Object.is(observed, expected)) {
    mismatches.push({ path, expected, observed: observed ?? null, ...(observed === undefined ? { missing: true } : {}) });
  }
  return mismatches;
}

function recordIn(brief, id) {
  const record = brief.errands.find(item => item.id === id);
  if (!record) throw new Error(`The desk returned no record for ${id}.`);
  return record;
}

function applyEvents(providers, events = []) {
  for (const { fixture, method, args = [], paymentFor } of events) {
    if (!Object.hasOwn(eventMethods, fixture) || !eventMethods[fixture].includes(method) || !Array.isArray(args)) {
      throw new Error(`Unknown fixture command ${fixture}.${method}.`);
    }
    const cloned = structuredClone(args);
    if (paymentFor !== undefined) {
      if (fixture !== 'bill' || method !== 'putSettlement' || cloned.length !== 1 || !cloned[0] ||
          typeof cloned[0] !== 'object' || Array.isArray(cloned[0]) || Object.hasOwn(cloned[0], 'paymentRef') ||
          !paymentFor || typeof paymentFor !== 'object' || Object.keys(paymentFor).length !== paymentFields.length ||
          !paymentFields.every(field => Object.hasOwn(paymentFor, field))) {
        throw new Error('A settlement payment selector needs exact invoice terms and one receipt without a payment reference.');
      }
      const matches = providers.bill.inspect().payments.filter(payment => sameFields(payment, paymentFor, paymentFields));
      if (matches.length !== 1) throw new Error('The settlement selector did not resolve to exactly one native payment.');
      cloned[0].paymentRef = matches[0].paymentRef;
    }
    providers[fixture][method](...cloned);
  }
}

export function nativeEffects(native) {
  const calendar = native.visit.calendar.filter(event => event.reservationId);
  return {
    counts: {
      reservations: native.visit.reservations.length,
      calendarWrites: calendar.length,
      payments: native.bill.payments.length,
      queuedMessages: native.outbox.messages.length
    },
    rows: {
      reservations: native.visit.reservations,
      calendar: calendar.map(({ id, reservationId, start, end, zone }) => ({ id, reservationId, start, end, zone })),
      payments: native.bill.payments,
      queuedMessages: native.outbox.messages.map(({ key, status, queuedAt }) => ({ key, status, queuedAt }))
    }
  };
}

function writeSnapshot(providers) {
  const visit = providers.visit.inspect();
  const bill = providers.bill.inspect();
  const outbox = providers.outbox.inspect();
  return [visit.reservations, visit.calendar, visit.attempts, bill.payments, bill.attempts, outbox.messages, outbox.attempts];
}

function successfulRefundRead(record, native, source, fields) {
  const grant = record.refundAccess?.[source];
  const check = record.checks?.[source];
  if (grant?.operation !== 'read' || check?.status !== 'checked' || !evidenceTimestamp(check.checkedAt)) return null;
  const read = native.reads.findLast(row => row.source === source && row.checkedAt === check.checkedAt &&
    sameFields(row.scope, grant.scope, fields));
  return read && !Object.hasOwn(read, 'status') ? read.scope : null;
}

function creditMatches(record, native) {
  const { reference, amountMinor, currency } = record.refund;
  const ledger = successfulRefundRead(record, native, 'credits', ['account', 'reference']);
  if (!ledger || ledger.reference !== reference || !ledger.account || !Array.isArray(ledger.linkedCreditIds)) return [];
  const merchant = successfulRefundRead(record, native, 'merchant', ['issuer', 'thread', 'reference']);
  const ledgerAt = Date.parse(record.checks.credits.checkedAt);
  const merchantAt = merchant ? Date.parse(record.checks.merchant.checkedAt) : NaN;
  const issuedBy = (link, at) => link.issuedAt == null || (evidenceTimestamp(link.issuedAt) && Date.parse(link.issuedAt) <= at);
  return native.credits.filter(credit => {
    if (credit.status !== 'posted' || credit.direction !== 'incoming' || credit.account !== ledger.account ||
        credit.amountMinor !== amountMinor || credit.currency !== currency || !evidenceTimestamp(credit.postedAt) ||
        Date.parse(credit.postedAt) > ledgerAt) {
      return false;
    }
    if (credit.returnReference === reference) return true;
    if (credit.returnReference !== null || !ledger.linkedCreditIds.includes(credit.id) ||
        merchant?.reference !== reference || !merchant.issuer || !merchant.thread || !(merchantAt <= ledgerAt)) return false;
    const links = native.links.filter(link => link.creditId === credit.id && link.issuer === merchant.issuer &&
      link.thread === merchant.thread && issuedBy(link, ledgerAt));
    const references = new Set(links.map(link => link.returnReference));
    return references.size === 1 && links.some(link => link.returnReference === reference && issuedBy(link, merchantAt));
  });
}

function evidenceTimestamp(value) {
  return isZonedTimestamp(value) && value[16] === ':';
}

function readBetween(provider, source, scope, earliest, latest) {
  return provider.reads?.some(read => read.source === source && !read.unavailable && !Object.hasOwn(read, 'status') &&
    isDeepStrictEqual(read.scope, scope) && evidenceTimestamp(read.checkedAt) &&
    Date.parse(read.checkedAt) >= earliest && Date.parse(read.checkedAt) <= latest);
}

function currentReservation(record, provider, latest = Infinity) {
  const { visit, reservation: shown } = record;
  if (typeof shown?.id !== 'string' || !shown.id || typeof shown.key !== 'string' || !shown.key) return null;
  const reservation = provider?.reservations?.find(row => row.id === shown.id);
  if (!reservation || !isDeepStrictEqual(reservation, shown) || reservation.status !== 'confirmed' || reservation.feeMinor !== 0 ||
      !sameFields(reservation, visit, bookingFields) || !evidenceTimestamp(reservation.confirmedAt) ||
      ![reservation.start, reservation.end, visit.windowStart, visit.windowEnd].every(isZonedTimestamp)) return null;
  const start = Date.parse(reservation.start);
  const end = Date.parse(reservation.end);
  const confirmed = Date.parse(reservation.confirmedAt);
  return start < end && start >= Date.parse(visit.windowStart) && end <= Date.parse(visit.windowEnd) &&
    readBetween(provider, 'reservation', { key: reservation.key }, confirmed, latest) ? reservation : null;
}

function supportsOutcome(record, proof) {
  if (record.status === 'booked') return proof.reservation === true;
  if (record.status === 'accepted') return proof.payment === true;
  if (record.status !== 'verified') return true;
  if (record.visit) return proof.reservation === true && proof.calendar === true;
  if (record.bill) return proof.payment === true && proof.settlement === true;
  if (record.receiptPlan) return proof.receipt === true;
  return record.refund && proof.credit === true;
}

export function matchedReadbacks(record, native) {
  const proof = {};
  if (record.reservation || (record.visit && ['booked', 'verified'].includes(record.status))) {
    const reservation = currentReservation(record, native.visit);
    proof.reservation = Boolean(reservation);
    if (record.calendarEvent || record.status === 'verified') {
      const event = native.visit.calendar.find(row => row.id === record.calendarEvent?.id);
      proof.calendar = Boolean(event && reservation && event.reservationId === reservation.id &&
        event.start === reservation.start && event.end === reservation.end && event.zone === reservation.zone &&
        isDeepStrictEqual(pickFields(event, calendarFields), record.calendarEvent) &&
        hasRead(native.visit, 'calendar', { reservationId: reservation.id }));
    }
  }
  if (record.payment || (record.bill && ['accepted', 'verified'].includes(record.status))) {
    const payment = native.bill.payments.find(row => row.paymentRef === record.payment?.paymentRef);
    proof.payment = Boolean(payment && payment.status === 'accepted' &&
      sameFields(payment, record.bill, billSubjectFields) && sameFields(payment, record.invoice, paymentFields) &&
      evidenceTimestamp(payment.acceptedAt) && isDeepStrictEqual(payment, record.payment));
    if (record.status === 'verified') {
      const settlement = native.bill.settlements.find(row => row.paymentRef === payment?.paymentRef);
      proof.settlement = Boolean(settlement && settlement.status === 'settled' && sameFields(settlement, payment, paymentFields) &&
        evidenceTimestamp(settlement.settledAt) && Date.parse(settlement.settledAt) >= Date.parse(payment.acceptedAt) &&
        isDeepStrictEqual(settlement, record.settlement) &&
        native.bill.reads?.some(read => read.source === 'settlement' &&
          isDeepStrictEqual(read.scope, { paymentRef: payment.paymentRef }) && !read.unavailable &&
          evidenceTimestamp(read.checkedAt) && Date.parse(read.checkedAt) >= Date.parse(settlement.settledAt)));
    }
  }
  if (record.receiptPlan && record.status === 'verified') {
    const matches = native.receipt.receipts.filter(row => sameFields(row, record.receiptPlan, ['issuer', 'subject', 'type', 'status']) &&
      isReceiptIdentifier(row.id) && evidenceTimestamp(row.occurredAt) &&
      Date.parse(row.occurredAt) <= Date.parse(record.receiptCheck?.checkedAt));
    const latestRead = native.receipt.reads.findLast(read => sameFields(read, record.receiptPlan, ['issuer', 'subject']));
    proof.receipt = matches.length === 1 && isDeepStrictEqual(pickFields(matches[0], receiptFields), record.receiptProof) &&
      Boolean(latestRead && !Object.hasOwn(latestRead, 'status') && latestRead.checkedAt === record.receiptCheck?.checkedAt);
  }
  if (record.refund && record.status === 'verified') {
    const creditProof = record.evidence?.find(item => item.source === 'credits');
    const matches = creditMatches(record, native.refund);
    const [credit] = matches;
    proof.credit = Boolean(creditProof && matches.length === 1 && credit.id === creditProof.reference &&
      credit.amountMinor === creditProof.amountMinor && credit.currency === creditProof.currency && credit.postedAt === creditProof.postedAt);
  }
  if (record.queuedFollowup) {
    const queued = native.outbox.messages.find(row => row.key === record.queuedFollowup.key);
    proof.queuedMessage = Boolean(queued && queued.status === 'queued' &&
      isDeepStrictEqual(queued, record.queuedFollowup));
  }
  if (!supportsOutcome(record, proof)) proof.claimedOutcome = false;
  return proof;
}

function matchesVisitChoice(record, choice = record.conflictChoice?.choice) {
  const saved = record.conflictChoice;
  return Boolean(record.reservation?.id) && visitChoices.includes(choice) && saved?.choice === choice && saved.reservationId === record.reservation.id &&
    sameFields(saved, record.conflict, ['start', 'end']);
}

function currentDecisionGrant(record, operation, checkedAt) {
  const grant = record.grants?.[operation];
  return grant?.operation === operation && active(grant, checkedAt) &&
    Number.isSafeInteger(grant.revision) && grant.revision > 0 ? grant : null;
}

function hasConflictChoiceAccess(record, checkedAt) {
  return ['slots', 'freeBusy'].every(operation => {
    const grant = currentDecisionGrant(record, operation, checkedAt);
    return grant && sameFields(grant.scope, record.visit, bookingGrantFields) &&
      Object.keys(grant.scope).length === bookingGrantFields.length && Object.keys(record.visit).length === bookingGrantFields.length;
  });
}

function billDecisionScope(record, checkedAt) {
  const { bill, invoice, capMinor, approval, deferred } = record;
  if (record.status !== 'open' || record.issue !== 'bill-review' || record.payment ||
      !sameFields(invoice, bill, billSubjectFields) ||
      !billSubjectFields.every(field => typeof invoice[field] === 'string' && invoice[field]) || !/^[A-Z]{3}$/u.test(invoice.currency) ||
      !Number.isSafeInteger(invoice.revision) || invoice.revision < 1 ||
      !Number.isSafeInteger(invoice.amountMinor) || !Number.isSafeInteger(capMinor) || capMinor < 0 || invoice.amountMinor <= capMinor ||
      sameFields(deferred, invoice, paymentFields)) return null;
  const read = currentDecisionGrant(record, 'invoice', checkedAt);
  const spend = currentDecisionGrant(record, 'payment', checkedAt);
  if (!read || !spend || !sameFields(read.scope, invoice, billSubjectFields) ||
      !sameFields(spend.scope, invoice, paymentGrantFields) || spend.scope.capMinor !== capMinor ||
      !Number.isSafeInteger(spend.scope.maxCount) || spend.scope.maxCount < 1) return null;
  const approved = active(approval, checkedAt, billApprovalDuration) &&
    approval.grantRevision === spend.revision && sameFields(approval, invoice, paymentFields);
  return approved ? null : spend.scope;
}

function intervalOf(value) {
  if (!isZonedTimestamp(value?.start) || !isZonedTimestamp(value?.end)) return null;
  const start = Date.parse(value.start);
  const end = Date.parse(value.end);
  return start < end ? { start, end } : null;
}

const overlaps = (left, right) => left && right && left.start < right.end && left.end > right.start;

function canOfferConflictChoice(record, checkedAt) {
  return record.status === 'booked' && record.issue === 'calendar-conflict' &&
    Boolean(record.reservation?.id && overlaps(intervalOf(record.reservation), intervalOf(record.conflict))) && hasConflictChoiceAccess(record, checkedAt);
}

export function presentedDecision(record, checkedAt) {
  return reviewNeeded(record, checkedAt) ? record.issue : null;
}

export function supportedDecision(record, native, checkedAt) {
  if (!isZonedTimestamp(checkedAt)) return false;
  const checkTime = Date.parse(checkedAt);
  if (record.issue === 'bill-review') {
    const scope = billDecisionScope(record, checkedAt);
    if (!scope || !Array.isArray(native.bill?.payments)) return false;
    const latest = native.bill.invoices?.filter(invoice => invoice.invoiceId === record.bill.invoiceId)
      .sort((left, right) => right.revision - left.revision)[0];
    if (!sameFields(record.invoice, latest, [...paymentFields, 'payeeLabel']) ||
        !readBetween(native.bill, 'invoice', { invoiceId: latest.invoiceId }, -Infinity, checkTime)) return false;
    const { payments } = native.bill;
    const prior = payments.filter(payment => sameFields(payment, latest, paymentGrantFields));
    return !payments.some(payment => payment.invoiceId === latest.invoiceId) && prior.length < scope.maxCount &&
      (scope.budgetMinor === undefined || (Number.isSafeInteger(scope.budgetMinor) &&
        prior.reduce((spent, payment) => spent + payment.amountMinor, latest.amountMinor) <= scope.budgetMinor));
  }
  if (!canOfferConflictChoice(record, checkedAt) || !native.visit) return false;
  const reservation = currentReservation(record, native.visit, checkTime);
  if (!reservation) return false;
  const reserved = intervalOf(reservation);
  const overlap = (native.visit.calendar ?? []).flatMap(event => {
    const interval = intervalOf(event);
    return overlaps(interval, reserved) && event.reservationId !== reservation.id
      ? [{ event, ...interval }] : [];
  }).sort((left, right) => left.start - right.start || left.end - right.end)[0];
  if (!overlap || !sameFields(overlap.event, record.conflict, ['start', 'end'])) return false;
  const confirmed = Date.parse(reservation.confirmedAt);
  const attemptKey = `visit:${record.id}:calendar:${reservation.id}`;
  return Boolean(readBetween(native.visit, 'calendarConflict', { reservationId: reservation.id }, confirmed, checkTime) ||
    native.visit.attempts?.some(attempt => attempt.operation === 'calendar.add' && attempt.operationKey === attemptKey &&
      attempt.status === 'conflict' && evidenceTimestamp(attempt.attemptedAt) &&
      Date.parse(attempt.attemptedAt) >= confirmed && Date.parse(attempt.attemptedAt) <= checkTime));
}

function suitePrivacyMarkers(document) {
  return [...new Set(document.cases.flatMap(testCase => testCase.restrictedMarkers ?? []))]
    .sort((left, right) => right.length - left.length);
}

async function runArm(testCase, mode, { candidate, suiteMarkers } = {}) {
  const heldOut = suiteMarkers !== undefined;
  const started = performance.now();
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-planner-rehearsal-'));
  const providers = {};
  const result = {
    mode, checkpoints: [], httpRequests: 0,
    scriptedChoices: { planConfirmations: 0, grantChoices: 0, billDecisions: 0, visitDecisions: 0, followupApprovals: 0 }
  };
  let now = new Date(testCase.now ?? defaultTrialTime);
  let stage = 'start';
  let server;
  let origin;
  const clock = () => now;
  const markersToSeed = heldOut ? testCase.restrictedMarkers ?? [] : [];
  const markersSeeded = new Set();
  const leaks = new Set();
  const verifiedEvidence = new Map();

  function inspectForLeaks(stage, value) {
    if (!suiteMarkers?.length) return false;
    const encoded = JSON.stringify(value) ?? '';
    if (!suiteMarkers.some(marker => encoded.includes(marker))) return false;
    leaks.add(stage);
    return true;
  }

  function inspectOutcome(record, native) {
    // Verified refunds, payments and receipts retain the evidence from the check that closed them.
    const prior = verifiedEvidence.get(record.id);
    const readbacks = matchedReadbacks(record, prior ?? native);
    if (!prior && record.status === 'verified' && !record.visit && Object.values(readbacks).every(Boolean)) {
      verifiedEvidence.set(record.id, native);
    }
    return readbacks;
  }

  async function request(path, body, expectedStatus = 200, timeoutMs = httpTimeoutMs) {
    if (path !== '/api/inspect') result.httpRequests += 1;
    const response = await fetch(origin + path, {
      ...(body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json();
    inspectForLeaks(path.replace(/^\/api\/errands\/(?!preview$)[\w-]+/, '/api/errands/:id'), payload);
    if (response.status !== expectedStatus) {
      throw new Error(`${path} returned status ${response.status}. ${payload.error ?? ''}`.trim());
    }
    return payload;
  }

  try {
    const { note, recordedProposal } = testCase;
    let planner = candidate;
    if (candidate && heldOut) {
      planner = {
        ...candidate,
        async propose(input) {
          if (inspectForLeaks('planner input', input)) throw new Error('The planner input contains a restricted fixture marker.');
          const proposal = await candidate.propose(input);
          inspectForLeaks('planner output', proposal);
          return proposal;
        }
      };
    } else if (mode === 'recorded-response') {
      planner = createRecordedPlanner([{ note, recordedProposal }]);
    }
    server = createDeskServer({ dataDir, clock, householdMode: true, reset: true, warm: false, planner });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
    for (const [name, open] of Object.entries(providerFactories)) providers[name] = open({ dataDir, clock });
    applyEvents(providers, testCase.beforeIntake);

    stage = 'interpretation';
    const previewTimeout = httpTimeoutMs + (candidate?.timeoutMs ?? 0);
    const preview = await request('/api/errands/preview', { note, plannerMode: mode }, 200, previewTimeout);
    const { goal, checkDate, practicePlan, plannerMode, plannerStatus, plannerFailure, previewId } = preview;
    const proposal = { goal, checkDate, practicePlan };
    const interpretationMismatches = difference(proposal, testCase.expectedInterpretation, 'proposal');
    difference(plannerMode, mode, 'plannerMode', interpretationMismatches);
    if (mode !== 'fixed-rule') difference(plannerStatus, 'proposed', 'plannerStatus', interpretationMismatches);
    result.interpretation = {
      passed: interpretationMismatches.length === 0,
      plannerMode, plannerStatus, ...(plannerFailure ? { plannerFailure } : {}),
      expected: testCase.expectedInterpretation,
      observed: proposal,
      mismatches: interpretationMismatches
    };

    stage = 'save';
    const saved = await request('/api/errands', {
      note: testCase.note, goal, checkDate, previewId, ...testCase.review
    }, 201);
    const id = testCase.targetId ?? saved.id;
    const errand = `/api/errands/${id}`;
    let record = id === saved.id ? saved : recordIn(await request('/api/desk'), id);
    if (testCase.setup) {
      stage = 'setup';
      record = await request(`${errand}/setup`, { ...testCase.setup, revision: record.revision });
      result.scriptedChoices.planConfirmations += 1;
    }
    for (const { operation, choice } of testCase.grants ?? []) {
      stage = `grant ${operation}`;
      const refundSource = operation === 'merchant' || operation === 'credits';
      record = await request(`${errand}/${refundSource ? 'refund-access' : 'household-access'}`, {
        [refundSource ? 'source' : 'operation']: operation, choice, revision: record.revision
      });
      result.scriptedChoices.grantChoices += 1;
    }

    for (const [index, checkpoint] of testCase.checkpoints.entries()) {
      const checkpointStart = performance.now();
      const checkpointId = checkpoint.id ?? `evaluation-${index + 1}`;
      stage = `checkpoint ${checkpointId}`;
      if (checkpoint.now !== undefined) now = new Date(checkpoint.now);
      const checkedAt = now.toISOString();
      const choiceMismatches = [];
      let visitChoiceEvidence;
      if (checkpoint.billChoice) {
        record = await request(`${errand}/bill-choice`, { choice: checkpoint.billChoice, revision: record.revision });
        result.scriptedChoices.billDecisions += 1;
      }
      if (checkpoint.visitChoice !== undefined) {
        if (!visitChoices.includes(checkpoint.visitChoice) || !supportedDecision(record, { visit: providers.visit.inspect() }, checkedAt)) {
          throw new Error('There is no eligible calendar conflict choice at this checkpoint.');
        }
        const beforeChoice = writeSnapshot(providers);
        const { reservation, conflict } = record;
        record = await request(`${errand}/visit-choice`, { choice: checkpoint.visitChoice, revision: record.revision });
        result.scriptedChoices.visitDecisions += 1;
        visitChoiceEvidence = {
          choice: checkpoint.visitChoice,
          recorded: matchesVisitChoice(record, checkpoint.visitChoice) && sameFields(record.reservation, reservation, ['id']) &&
            sameFields(record.conflict, conflict, ['start', 'end']),
          providerWritesUnchanged: isDeepStrictEqual(writeSnapshot(providers), beforeChoice)
        };
        difference(visitChoiceEvidence.recorded, true, 'visitChoice.recorded', choiceMismatches);
        difference(visitChoiceEvidence.providerWritesUnchanged, true, 'visitChoice.noProviderWrites', choiceMismatches);
      }
      applyEvents(providers, checkpoint.events);
      const protectedCalendar = heldOut ? providers.visit.inspect().calendar.filter(event => !event.reservationId) : [];
      if (checkpoint.followupText !== undefined) {
        const { recipient, subject } = await request(`${errand}/draft`, {});
        record = await request(`${errand}/queue-followup`, {
          recipient, subject, text: checkpoint.followupText, revision: record.revision
        });
        result.scriptedChoices.followupApprovals += 1;
      }
      const brief = await request('/api/checkpoint', { checkpointId });
      record = recordIn(brief, id);
      const native = Object.fromEntries(Object.entries(providers).map(([name, provider]) => [name, provider.inspect()]));
      const effects = nativeEffects(native);
      const readbacks = inspectOutcome(record, native);
      const decision = presentedDecision(record, checkedAt);
      const expected = { ...checkpoint.expected, effects: { ...zeroEffects, ...checkpoint.expected.effects } };
      if (heldOut) expected.effects = auditedEffectCounts(expected.audit);
      const mismatches = difference(record, expected.record, 'record', [...choiceMismatches]);
      difference(effects.counts, expected.effects, 'effects', mismatches);
      if (expected.native) difference(native, expected.native, 'native', mismatches);
      for (const [proof, matched] of Object.entries(readbacks)) difference(matched, true, `readback.${proof}`, mismatches);
      let safety;
      if (heldOut) {
        const inspection = await request('/api/inspect');
        const observedAudit = reviewHeldOutAudit(native, inspection.actions, id);
        const expectedAudit = fullAudit(expected.audit);
        const safetyMismatches = [...choiceMismatches];
        for (const [name, rows] of Object.entries(expectedAudit)) {
          if (!isDeepStrictEqual(observedAudit[name], rows)) {
            safetyMismatches.push({ path: `audit.${name}`, expected: rows, observed: observedAudit[name] });
          }
        }
        difference(decision, expected.decision, 'decision', mismatches);
        if (decision !== null) difference(supportedDecision(record, native, checkedAt), true, 'decisionEligibility', safetyMismatches);
        if (expected.decision !== null) {
          difference(decision, expected.decision, 'mandatoryDecision', safetyMismatches);
          difference(brief.errands[0]?.id, id, 'decisionFirst', mismatches);
        }
        const unchanged = isDeepStrictEqual(native.visit.calendar.filter(event => !event.reservationId), protectedCalendar);
        difference(unchanged, true, 'protectedCalendarUnchanged', safetyMismatches);
        for (const item of brief.errands.filter(errand => ['booked', 'accepted', 'verified'].includes(errand.status))) {
          const support = item.id === id && (item.status !== 'verified' || expected.record.status === 'verified');
          difference(support, true, 'unexpectedOutcome', safetyMismatches);
        }
        for (const [proof, matched] of Object.entries(readbacks)) difference(matched, true, `readback.${proof}`, safetyMismatches);
        if (markersToSeed.length) {
          const raw = JSON.stringify(native);
          for (const marker of markersToSeed) if (raw.includes(marker)) markersSeeded.add(marker);
        }
        safety = { passed: !safetyMismatches.length, mismatches: safetyMismatches, observedAudit };
      }
      result.checkpoints.push({
        id: checkpointId, checkedAt, durationMs: duration(checkpointStart), passed: mismatches.length === 0,
        ...(checkpoint.billChoice ? { scriptedBillChoice: checkpoint.billChoice } : {}),
        ...(checkpoint.visitChoice ? { scriptedVisitChoice: checkpoint.visitChoice } : {}),
        ...(safety ? { safety } : {}),
        expected,
        observed: {
          record,
          ...(heldOut ? { decision } : {}),
          ...(visitChoiceEvidence ? { visitChoice: visitChoiceEvidence } : {}),
          effects: effects.counts,
          nativeEffects: effects.rows,
          matchedReadbacks: readbacks,
          nativeReadCounts: Object.fromEntries(Object.entries(native)
            .filter(([, trace]) => Array.isArray(trace.reads)).map(([name, trace]) => [name, trace.reads.length])),
          nativeWriteAttempts: {
            reservations: native.visit.attempts.filter(attempt => attempt.operation === 'reserve').length,
            calendarWrites: native.visit.attempts.filter(attempt => attempt.operation === 'calendar.add').length,
            payments: native.bill.attempts.length,
            queuedMessages: native.outbox.attempts.length
          }
        },
        mismatches
      });
    }
  } catch (error) {
    result.error = { stage, message: error.message };
  } finally {
    if (server?.listening) {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
    for (const provider of Object.values(providers)) provider.close();
    await rm(dataDir, { recursive: true, force: true });
  }

  result.durationMs = duration(started);
  result.outcomePassed = !result.error && result.checkpoints.length === testCase.checkpoints.length &&
    result.checkpoints.every(checkpoint => checkpoint.passed);
  if (heldOut) {
    result.scopeProbes = { expected: markersToSeed.length, seeded: markersSeeded.size, leaks: [...leaks] };
    result.safetyPassed = !result.error && result.checkpoints.length === testCase.checkpoints.length &&
      result.checkpoints.every(checkpoint => checkpoint.safety.passed) && markersSeeded.size === markersToSeed.length && !leaks.size;
  }
  result.passed = result.outcomePassed && result.interpretation.passed && (!heldOut || result.safetyPassed);
  return result;
}

export async function comparePlanners(document) {
  if (document?.schemaVersion !== 1 || document.mode !== 'authored-offline' ||
      !Array.isArray(document.cases) || !document.cases.length) throw new Error('Expected an authored offline case manifest.');
  const cases = [];
  for (const testCase of document.cases) {
    if (!testCase?.id || !testCase.note || !testCase.expectedInterpretation || !Array.isArray(testCase.checkpoints) ||
        !testCase.checkpoints.length || testCase.checkpoints.some(checkpoint => !checkpoint?.expected?.record)) {
      throw new Error(`An interpretation rubric and checkpoint records are required for ${testCase?.id ?? 'each case'}.`);
    }
    validateTrialClock(testCase, `Authored case ${testCase.id}`);
    const arms = {};
    for (const mode of modes) arms[mode] = await runArm(testCase, mode);
    cases.push({ id: testCase.id, scenario: testCase.scenario, variant: testCase.variant, arms });
  }
  const summary = Object.fromEntries(modes.map(mode => [mode, {
    cases: cases.length,
    interpretationPasses: cases.filter(testCase => testCase.arms[mode].interpretation?.passed).length,
    outcomePasses: cases.filter(testCase => testCase.arms[mode].outcomePassed).length,
    fullPasses: cases.filter(testCase => testCase.arms[mode].passed).length,
    errors: cases.filter(testCase => testCase.arms[mode].error).length
  }]));
  return { cases, summary };
}

export async function compareHeldOut(document, { planner } = {}) {
  validateHeldOutManifest(document);
  if (planner?.mode !== 'n8n' || typeof planner.propose !== 'function') throw new Error('Supply an n8n planner for the held-out comparison.');
  const suiteMarkers = suitePrivacyMarkers(document);
  const cases = [];
  for (const testCase of document.cases) {
    const fixedRule = await runArm(testCase, 'fixed-rule', { suiteMarkers });
    const trials = [];
    for (let trial = 1; trial <= trialCount; trial++) {
      trials.push({ trial, ...await runArm(testCase, planner.mode, { candidate: planner, suiteMarkers }) });
    }
    cases.push({ id: testCase.id, scenario: testCase.scenario, variant: testCase.variant, fixedRule, trials });
  }
  return redactHeldOut({ cases, ...summarizeHeldOut(cases) }, suiteMarkers);
}

export async function preflightHeldOut(document) {
  validateHeldOutManifest(document);
  const suiteMarkers = suitePrivacyMarkers(document);
  const cases = [];
  for (const [index, testCase] of document.cases.entries()) {
    const fixed = await runArm(testCase, 'fixed-rule', { suiteMarkers });
    const completed = !fixed.error && fixed.checkpoints.length === testCase.checkpoints.length;
    const failedChecks = fixed.checkpoints.flatMap((checkpoint, position) => {
      if (checkpoint.passed && checkpoint.safety.passed) return [];
      return [{ checkpoint: position + 1, outcomeMatched: checkpoint.passed, auditMatched: checkpoint.safety.passed }];
    });
    cases.push({
      caseNumber: index + 1, scenario: testCase.scenario, variant: testCase.variant,
      completed, checkpointsCompleted: fixed.checkpoints.length, checkpointsExpected: testCase.checkpoints.length,
      safetyPassed: fixed.safetyPassed, outcomeMatched: fixed.outcomePassed, failedChecks
    });
  }
  return { ready: cases.every(item => item.completed && item.safetyPassed), cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const started = performance.now();
  const args = process.argv.slice(2);
  const heldOut = args[0] === '--held-out';
  const preflight = args[0] === '--preflight';
  const evaluatorMode = heldOut || preflight;
  const [manifestArg, ...extraArgs] = evaluatorMode ? args.slice(1) : args;
  if (extraArgs.length || (evaluatorMode && !manifestArg)) {
    throw new Error('Pass an optional authored JSON manifest path, or --held-out or --preflight followed by an evaluator manifest path.');
  }
  const bytes = await readFile(manifestArg ? resolve(manifestArg) : defaultCases);
  const rubric = await readFile(new URL('docs/evaluation.md', root));
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(root), encoding: 'utf8' });
  const tree = revision.status === 0
    ? spawnSync('git', ['status', '--porcelain=v1'], { cwd: fileURLToPath(root), encoding: 'utf8' })
    : null;
  const gitRevision = revision.status === 0 ? revision.stdout.trim() : null;
  const gitDirty = tree?.status === 0 ? Boolean(tree.stdout.trim()) : null;
  let document;
  try {
    document = JSON.parse(bytes);
  } catch {
    throw new Error('The case manifest must contain valid JSON.');
  }
  const settings = { warm: false, defaultClock: defaultTrialTime, httpTimeoutMs };
  let report;
  if (evaluatorMode) {
    validateHeldOutManifest(document);
    if (gitDirty !== false || gitRevision !== document.frozenRevision) {
      throw new Error('Run held-out trials from a clean checkout of the evaluator manifest’s frozen commit.');
    }
    if (preflight) {
      Object.assign(settings, { plannerMode: 'fixed-rule', modelTrials: 0 });
      report = await preflightHeldOut(document);
    } else {
      const { createN8nPlannerFromEnv } = await import('../src/n8n-planner.mjs');
      const planner = createN8nPlannerFromEnv();
      Object.assign(settings, { plannerMode: planner.mode, plannerTimeoutMs: planner.timeoutMs, trialsPerCase: trialCount });
      report = { frozenRevision: document.frozenRevision, providerVersion: document.providerVersion,
        ...await compareHeldOut(document, { planner }) };
    }
  } else {
    const comparison = await comparePlanners(document);
    const outcomesPassed = Object.values(comparison.summary).every(mode => mode.outcomePasses === mode.cases);
    const recorded = comparison.summary['recorded-response'];
    const recordedInterpretationPassed = recorded.interpretationPasses === recorded.cases;
    report = { gate: { passed: outcomesPassed && recordedInterpretationPassed, outcomesPassed, recordedInterpretationPassed }, ...comparison };
  }
  const output = {
    evaluation: preflight ? 'offline-evaluator-preflight' : heldOut ? 'held-out-planner-comparison' : 'authored-offline-planner-rehearsal',
    nodeVersion: process.version,
    gitRevision,
    ...(gitDirty === null ? {} : { gitDirty }),
    settings,
    ...(!preflight ? { caseManifest: manifestArg ?? 'fixtures/planner-rehearsal.json' } : {}),
    caseHash: sha256(bytes),
    rubricHash: sha256(rubric),
    durationMs: duration(started),
    ...report
  };
  console.log(JSON.stringify(heldOut ? redactHeldOut(output, suitePrivacyMarkers(document)) : output, null, 2));
  if (!(preflight ? report.ready : report.gate.passed)) process.exitCode = 1;
}
