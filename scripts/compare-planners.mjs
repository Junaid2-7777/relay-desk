import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openBillFixture } from '../src/bill-fixture.mjs';
import { openOutboxFixture } from '../src/outbox-fixture.mjs';
import { openReceiptFixture } from '../src/receipt-fixture.mjs';
import { openRefundFixture } from '../src/refund-fixture.mjs';
import { createDeskServer } from '../src/server.mjs';
import { openVisitFixture } from '../src/visit-fixture.mjs';

const root = new URL('../', import.meta.url);
const defaultCases = new URL('fixtures/planner-rehearsal.json', root);
const monday = '2026-11-23T03:30:00.000Z';
const httpTimeoutMs = 5000;
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
  receipt: ['putSource', 'putReceipt'],
  refund: ['putEvent', 'putCredit', 'putLink', 'setAvailable'],
  visit: ['putSlot', 'putCalendarEvent', 'failNextReservationReply', 'failNextCalendarWrite']
};
const zeroEffects = { reservations: 0, calendarWrites: 0, payments: 0, queuedMessages: 0 };

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
  for (const { fixture, method, args = [] } of events) {
    if (!Object.hasOwn(eventMethods, fixture) || !eventMethods[fixture].includes(method) || !Array.isArray(args)) {
      throw new Error(`Unknown fixture command ${fixture}.${method}.`);
    }
    providers[fixture][method](...structuredClone(args));
  }
}

function nativeEffects(native) {
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

function creditMatches(record, native) {
  const { reference, amountMinor, currency } = record.refund;
  const creditsGrant = record.refundAccess?.credits;
  const ledger = creditsGrant?.scope;
  if (creditsGrant?.operation !== 'read' || ledger?.reference !== reference || !ledger.account) return [];
  const merchantGrant = record.refundAccess?.merchant;
  const merchant = merchantGrant?.operation === 'read' && merchantGrant.status === 'allowed' &&
    record.checks?.merchant?.status === 'checked' ? merchantGrant.scope : null;
  return native.credits.filter(credit => {
    if (credit.status !== 'posted' || credit.direction !== 'incoming' || credit.account !== ledger.account ||
        credit.amountMinor !== amountMinor || credit.currency !== currency || !Number.isFinite(Date.parse(credit.postedAt))) {
      return false;
    }
    if (credit.returnReference === reference) return true;
    if (credit.returnReference !== null || merchant?.reference !== reference || !merchant.issuer || !merchant.thread) return false;
    const references = new Set(native.links
      .filter(link => link.creditId === credit.id && link.issuer === merchant.issuer && link.thread === merchant.thread)
      .map(link => link.returnReference));
    return references.size === 1 && references.has(reference);
  });
}

function matchedReadbacks(record, native) {
  const proof = {};
  if (record.reservation || (record.visit && ['booked', 'verified'].includes(record.status))) {
    const reservation = native.visit.reservations.find(row => row.id === record.reservation?.id);
    proof.reservation = Boolean(reservation && reservation.status === 'confirmed' && reservation.feeMinor === 0 &&
      ['issuer', 'service', 'subject', 'zone'].every(field => reservation[field] === record.visit?.[field]) &&
      difference(reservation, record.reservation, 'reservation').length === 0);
    if (record.calendarEvent || record.status === 'verified') {
      const event = native.visit.calendar.find(row => row.id === record.calendarEvent?.id);
      proof.calendar = Boolean(event && reservation && event.reservationId === reservation.id &&
        event.start === reservation.start && event.end === reservation.end && event.zone === reservation.zone &&
        difference(event, record.calendarEvent, 'calendarEvent').length === 0);
    }
  }
  if (record.payment || (record.bill && ['accepted', 'verified'].includes(record.status))) {
    const payment = native.bill.payments.find(row => row.paymentRef === record.payment?.paymentRef);
    proof.payment = Boolean(payment && difference(payment, record.payment, 'payment').length === 0);
    if (record.status === 'verified') {
      const settlement = native.bill.settlements.find(row => row.paymentRef === payment?.paymentRef);
      proof.settlement = Boolean(settlement && record.settlement && settlement.status === 'settled' &&
        difference(settlement, record.settlement, 'settlement').length === 0);
    }
  }
  if (record.receiptPlan && record.status === 'verified') {
    const receipt = native.receipt.receipts.find(row => row.issuer === record.receiptPlan.issuer &&
      row.id === record.receiptProof?.id && row.subject === record.receiptPlan.subject &&
      row.type === record.receiptPlan.type && row.status === record.receiptPlan.status);
    proof.receipt = Boolean(receipt && difference(receipt, record.receiptProof, 'receiptProof').length === 0);
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
      difference(queued, record.queuedFollowup, 'queuedFollowup').length === 0);
  }
  return proof;
}

async function runArm(testCase, mode) {
  const started = performance.now();
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-planner-rehearsal-'));
  const providers = {};
  const result = {
    mode, checkpoints: [], httpRequests: 0,
    scriptedChoices: { planConfirmations: 0, grantChoices: 0, billDecisions: 0, followupApprovals: 0 }
  };
  let now = new Date(testCase.now ?? monday);
  let stage = 'start';
  let server;
  let origin;
  const clock = () => now;

  async function request(path, body, expectedStatus = 200) {
    result.httpRequests += 1;
    const response = await fetch(origin + path, {
      ...(body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      }),
      signal: AbortSignal.timeout(httpTimeoutMs)
    });
    const payload = await response.json();
    if (response.status !== expectedStatus) {
      throw new Error(`${path} returned status ${response.status}. ${payload.error ?? ''}`.trim());
    }
    return payload;
  }

  try {
    const recorded = testCase.recordedProposal;
    const planner = mode === 'recorded-response' ? {
      mode,
      propose: async () => structuredClone(recorded)
    } : undefined;
    server = createDeskServer({ dataDir, clock, householdMode: true, reset: true, warm: false, planner });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
    for (const [name, open] of Object.entries(providerFactories)) providers[name] = open({ dataDir, clock });
    applyEvents(providers, testCase.beforeIntake);

    stage = 'interpretation';
    const preview = await request('/api/errands/preview', { note: testCase.note });
    const { goal, checkDate, practicePlan, plannerMode, plannerStatus, previewId } = preview;
    const proposal = { goal, checkDate, practicePlan };
    const interpretationMismatches = difference(proposal, testCase.expectedInterpretation, 'proposal');
    difference(plannerMode, mode, 'plannerMode', interpretationMismatches);
    if (mode === 'recorded-response') difference(plannerStatus, 'proposed', 'plannerStatus', interpretationMismatches);
    result.interpretation = {
      passed: interpretationMismatches.length === 0,
      plannerMode, plannerStatus,
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
      if (checkpoint.billChoice) {
        record = await request(`${errand}/bill-choice`, { choice: checkpoint.billChoice, revision: record.revision });
        result.scriptedChoices.billDecisions += 1;
      }
      applyEvents(providers, checkpoint.events);
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
      const readbacks = matchedReadbacks(record, native);
      const expected = { ...checkpoint.expected, effects: { ...zeroEffects, ...checkpoint.expected.effects } };
      const mismatches = difference(record, expected.record, 'record');
      difference(effects.counts, expected.effects, 'effects', mismatches);
      if (expected.native) difference(native, expected.native, 'native', mismatches);
      for (const [proof, matched] of Object.entries(readbacks)) difference(matched, true, `readback.${proof}`, mismatches);
      result.checkpoints.push({
        id: checkpointId, checkedAt, durationMs: duration(checkpointStart), passed: mismatches.length === 0,
        ...(checkpoint.billChoice ? { scriptedBillChoice: checkpoint.billChoice } : {}),
        expected,
        observed: {
          record,
          effects: effects.counts,
          nativeEffects: effects.rows,
          matchedReadbacks: readbacks,
          nativeReadCounts: Object.fromEntries(Object.entries(native)
            .filter(([, trace]) => Array.isArray(trace.reads)).map(([name, trace]) => [name, trace.reads.length])),
          nativeWriteAttempts: {
            reservations: native.visit.attempts.filter(attempt => attempt.operation === 'reserve').length,
            calendarWrites: native.visit.attempts.filter(attempt => attempt.operation === 'calendar.add').length,
            payments: native.bill.attempts.length,
            queuedMessages: null
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
  result.passed = result.outcomePassed && result.interpretation.passed;
  return result;
}

export async function comparePlanners(document) {
  if (document?.schemaVersion !== 1 || document.mode !== 'authored-offline' ||
      !Array.isArray(document.cases) || !document.cases.length) throw new Error('Expected an authored offline case manifest.');
  const cases = [];
  for (const testCase of document.cases) {
    if (!testCase.id || !testCase.note || !testCase.expectedInterpretation || !testCase.checkpoints?.length ||
        testCase.checkpoints.some(checkpoint => !checkpoint.expected?.record)) {
      throw new Error(`An interpretation rubric and checkpoint records are required for ${testCase.id ?? 'each case'}.`);
    }
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const started = performance.now();
  const [manifestArg, ...extraArgs] = process.argv.slice(2);
  if (extraArgs.length) throw new Error('Pass at most one authored JSON manifest path.');
  const bytes = await readFile(manifestArg ? resolve(manifestArg) : defaultCases);
  const rubric = await readFile(new URL('docs/evaluation.md', root));
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(root), encoding: 'utf8' });
  const tree = revision.status === 0
    ? spawnSync('git', ['status', '--porcelain=v1'], { cwd: fileURLToPath(root), encoding: 'utf8' })
    : null;
  const report = await comparePlanners(JSON.parse(bytes));
  const outcomesPassed = Object.values(report.summary).every(mode => mode.outcomePasses === mode.cases);
  const recorded = report.summary['recorded-response'];
  const recordedInterpretationPassed = recorded.interpretationPasses === recorded.cases;
  const passed = outcomesPassed && recordedInterpretationPassed;
  console.log(JSON.stringify({
    evaluation: 'authored-offline-planner-rehearsal',
    nodeVersion: process.version,
    gitRevision: revision.status === 0 ? revision.stdout.trim() : null,
    ...(tree?.status === 0 ? { gitDirty: Boolean(tree.stdout.trim()) } : {}),
    settings: { warm: false, defaultClock: monday, httpTimeoutMs },
    caseManifest: manifestArg ?? 'fixtures/planner-rehearsal.json',
    caseHash: sha256(bytes),
    rubricHash: sha256(rubric),
    durationMs: duration(started),
    gate: { passed, outcomesPassed, recordedInterpretationPassed },
    ...report
  }, null, 2));
  if (!passed) process.exitCode = 1;
}
