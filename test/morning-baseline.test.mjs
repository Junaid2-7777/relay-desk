import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runManualSession } from '../scripts/manual-session.mjs';
import { createManualMorning, morningClock, permissionTargets } from '../scripts/morning-manual.mjs';
import { openBillFixture } from '../src/bill-fixture.mjs';
import { openRefundFixture } from '../src/refund-fixture.mjs';
import { mondayVisit, openVisitFixture } from '../src/visit-fixture.mjs';

const run = promisify(execFile);
const comparison = fileURLToPath(new URL('../scripts/compare-morning.mjs', import.meta.url));
const manualSession = fileURLToPath(new URL('../scripts/manual-session.mjs', import.meta.url));
const afternoon = 'slot-demo-3pm';
const afternoonStart = '2026-11-24T15:00:00+05:30';
const afternoonEnd = '2026-11-24T16:00:00+05:30';

async function pipeSession(scenario, commands) {
  const child = spawn(process.execPath, [manualSession, scenario], {
    env: { ...process.env, RELAY_CLOCK: 'invalid', RELAY_DATA_DIR: 'manual-session-must-ignore-this' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.end(`${commands.join('\n')}\n`);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  const [feedback, trace] = stdout.split('Session trace\n');
  return { feedback, trace: JSON.parse(trace) };
}

async function openManualCase(t, clock = morningClock) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-morning-test-'));
  const options = { dataDir, clock };
  const fixtures = { bill: openBillFixture(options), refund: openRefundFixture(options), visit: openVisitFixture(options) };
  t.after(async () => {
    for (const fixture of Object.values(fixtures)) fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  for (const fixture of Object.values(fixtures)) fixture.reset();
  return { fixtures, task: createManualMorning(fixtures, true, undefined, clock) };
}

test('the morning baseline pairs fixture inputs, permission scopes and outcomes through one checkpoint', async () => {
  const { stdout } = await run(process.execPath, [comparison]);
  const report = JSON.parse(stdout);
  assert.equal(report.passed, true);
  assert.equal(report.cutoff, 'first-morning-checkpoint');
  const paired = { sameFixtureInputs: true, sameAuthority: true, sameOutcome: true };
  assert.deepEqual(report.pairing, { cold: paired, warm: paired });

  for (const [scenario, arms] of Object.entries(report.scenarios)) {
    const warm = scenario === 'warm';
    for (const [mode, arm] of Object.entries(arms)) {
      const manual = mode === 'manual';
      const { total } = arm.counts;
      assert.equal(total.attentionOccasions, 1);
      assert.equal(arm.counts.setup.consentChoices, warm ? 0 : 2);
      assert.equal(total.humanLookups, manual ? (warm ? 7 : 1) : 0);
      assert.equal(total.checkClicks, manual ? 0 : 1);
      assert.equal(total.distinctBillDecisions, warm ? 1 : 0);
      assert.equal(total.billDecisionsTaken, 0);
      assert.equal(total.repeatPrompts, 0);
      assert.equal(arm.observed.independentReadback.reservations, warm ? 1 : 0);
      assert.equal(arm.observed.independentReadback.payments, 0);
      if (warm) assert.equal(arm.scriptedActions.ongoing[1].action, 'bill-decision-presented');
    }
  }
  assert.deepEqual(report.scenarios.warm.manual.observed.nativeReadCounts, { bill: 1, refund: 2, visit: 5 });
  assert.deepEqual(report.scenarios.warm['fixed-rule'].observed.nativeReadCounts, { bill: 1, refund: 2, visit: 6 });
});

test('piped cold session records consent but keeps the refused ledger and other sources private', async () => {
  const { feedback, trace } = await pipeSession('cold', [
    'reminders', 'look credits', 'decline credits', 'look credits', 'allow availability', 'allow availability',
    'look availability', 'look slots', 'pay bill', 'look unrecognized-private-phrase', 'finish', 'look availability'
  ]);
  assert.match(feedback, /starting reminders|last known amount/u);
  assert.equal(feedback.match(/Access is needed for incoming credits/gu)?.length, 2);
  assert.match(feedback, /Access declined for incoming credits/u);
  assert.match(feedback, /No busy time in this window/u);
  assert.equal(feedback.match(/Command not recognized/gu)?.length, 2);
  assert.doesNotMatch(feedback, /unrecognized-private-phrase|Synthetic private calendar title|credit-demo-unrelated-return|return-demo-1249|3pm|1,180/u);
  assert.equal(trace.clock, '2026-11-23T09:00:00+05:30');
  assert.equal(trace.cutoff, 'first-morning-checkpoint');
  assert.equal(trace.end, 'finished');
  assert.equal(trace.counts.setup.consentChoices, 2);
  assert.equal(trace.counts.ongoing.humanLookups, 1);
  assert.deepEqual(trace.actions.ongoing, [{ action: 'lookup', source: 'calendar-free-busy' }]);
  assert.deepEqual(trace.nativeReadCounts, { bill: 0, refund: 0, visit: 1 });
  assert.deepEqual(trace.writeAttempts, { reservations: 0, calendarWrites: 0, payments: 0 });
  assert.deepEqual(trace.independentReadback, {
    protectedCalendarUnchanged: true, reservations: 0, calendarWrites: 0, payments: 0, ledgerReads: 0,
    matchedNativeEvidence: { reservation: false, calendar: false, invoice: false, refundCredit: false }
  });
});

test('piped warm session compares the same fixtures and requires selected terms and explicit readbacks', async () => {
  const { feedback, trace } = await pipeSession('warm', [
    'look bill', 'look availability', 'look slots', 'choose slot-demo-11am', `book ${afternoon}`, `choose ${afternoon}`,
    `book ${afternoon}`, 'add calendar', 'look calendar', 'look booking', 'add calendar', 'look calendar', 'look shop', 'look credits', 'finish'
  ]);
  assert.match(feedback, /Current invoice ₹1,180\.00 \(revision 2\)\. Standing cap ₹900\.00/u);
  assert.match(feedback, /Payment is beyond this cutoff/u);
  assert.match(feedback, /Choose a displayed free offer/u);
  assert.match(feedback, /Choose the displayed offer before booking/u);
  assert.match(feedback, /Use look booking to verify the original reservation first/u);
  assert.match(feedback, /Verify the booking and submit its calendar entry first/u);
  assert.match(feedback, /The practice calendar lists the same appointment/u);
  assert.match(feedback, /No matching posted credit/u);
  assert.doesNotMatch(feedback, /slot-demo-11am|credit-demo-unrelated-return|Synthetic private calendar title|household-demo-broadband|ledger-demo/u);
  const { stdout } = await run(process.execPath, [comparison]);
  const baseline = JSON.parse(stdout).scenarios.warm.manual;
  assert.equal(trace.fixtureInputHash, baseline.fixtureInputHash);
  assert.deepEqual(trace.actions, baseline.scriptedActions);
  const { attentionOccasions, ...total } = baseline.counts.total;
  assert.equal(attentionOccasions, 1);
  assert.deepEqual(trace.counts, { ...baseline.counts, total });
  assert.deepEqual(trace.nativeReadCounts, baseline.observed.nativeReadCounts);
  assert.deepEqual(trace.writeAttempts, { reservations: 1, calendarWrites: 1, payments: 0 });
  assert.deepEqual(trace.outcomes, { visit: 'verified', bill: { status: 'open', decisionPresented: true }, refund: 'open' });
  assert.deepEqual(trace.independentReadback, {
    protectedCalendarUnchanged: true, reservations: 1, calendarWrites: 1, payments: 0, ledgerReads: 1,
    matchedNativeEvidence: { reservation: true, calendar: true, invoice: true, refundCredit: false }
  });
});

test('a competing offer does not replace selected terms, and changed terms and new busy time block writes', async t => {
  const { fixtures, task } = await openManualCase(t);
  const alternative = 'slot-demo-4pm';
  fixtures.visit.putSlot({ ...mondayVisit, id: alternative, start: afternoonEnd, end: '2026-11-24T17:00:00+05:30' });
  fixtures.visit.putSlot({ ...mondayVisit, id: 'slot-with-fee', start: afternoonEnd, end: '2026-11-24T17:00:00+05:30', feeMinor: 1200 });
  task.look('availability');
  assert.deepEqual(task.look('slots').offers.map(offer => offer.id), [afternoon, alternative]);
  assert.throws(() => task.choose('slot-with-fee'), /displayed free offer/u);
  task.choose(afternoon);
  assert.throws(() => task.book(alternative), /Choose the displayed offer/u);
  const booking = permissionTargets.get('booking');
  task.consent({ ...booking, choice: 'declined' });
  assert.throws(() => task.book(afternoon), /Access is needed/u);
  assert.deepEqual(fixtures.visit.inspect().attempts, []);
  task.consent({ ...booking, choice: 'allowed' });
  task.choose(afternoon);
  fixtures.visit.putSlot({ ...mondayVisit, id: afternoon, start: afternoonStart, end: afternoonEnd, revision: 2 });
  assert.equal(task.book(afternoon).reason, 'slot-revised');
  task.look('availability');
  task.look('slots');
  const chosen = task.choose(afternoon).selected;
  assert.equal(chosen.revision, 2);
  fixtures.visit.putCalendarEvent({ id: 'new-busy', start: afternoonStart, end: afternoonEnd, title: 'keep private' });
  assert.equal(task.book(afternoon).reason, 'calendar-conflict');
  assert.deepEqual(fixtures.visit.inspect().reservations, []);
  const { busy } = task.look('availability');
  assert.deepEqual(busy, [{ start: afternoonStart, end: afternoonEnd }]);
  task.look('slots');
  assert.throws(() => task.choose(afternoon), /outside busy time/u);
  task.choose(alternative);
  assert.equal(task.book(alternative).booking, 'submitted');
  assert.equal(fixtures.visit.inspect().reservations[0].slotId, alternative);
  assert.equal(fixtures.visit.inspect().reads.at(-1).source, 'slots');
});

test('native confirmation is explicit after a lost reservation reply and rechecked before adding the event', async t => {
  const { fixtures, task } = await openManualCase(t);
  task.look('availability');
  task.look('slots');
  task.choose(afternoon);
  fixtures.visit.failNextReservationReply();
  assert.equal(task.book(afternoon).booking, 'submitted');
  assert.equal(task.outcomes.visit.status, 'open');
  assert.throws(() => task.book(afternoon), /original reservation/u);
  assert.throws(() => task.addCalendar(), /verify the original reservation/u);
  assert.equal(fixtures.visit.inspect().reads.length, 2);
  assert.equal(task.look('booking').booking, 'confirmed');
  const calendar = permissionTargets.get('calendar');
  task.consent({ ...calendar, choice: 'declined' });
  assert.throws(() => task.addCalendar(), /Access is needed/u);
  assert.equal(fixtures.visit.inspect().attempts.length, 1);
  task.consent({ ...calendar, choice: 'allowed' });
  fixtures.visit.putCalendarEvent({ id: 'new-conflict', start: afternoonStart, end: afternoonEnd, title: 'keep private' });
  assert.deepEqual(task.addCalendar(), {
    calendar: 'conflict', busy: { start: afternoonStart, end: afternoonEnd }, next: 'The booking remains confirmed.'
  });
  assert.equal(task.outcomes.visit.status, 'booked');
  assert.equal(fixtures.visit.inspect().reservations.length, 1);
  assert.equal(fixtures.visit.inspect().calendar.filter(event => event.reservationId).length, 0);
});

test('a facilitator can use the prompt interactively and partial input closes without implied readback', { timeout: 10000 }, async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120 });
  let transcript = '';
  output.setEncoding('utf8').on('data', chunk => { transcript += chunk; });
  const ended = runManualSession('warm', { input, output });
  async function waitFor(phrase) {
    while (!transcript.includes(phrase)) {
      const next = await Promise.race([once(output, 'data'), ended]);
      assert.ok(Array.isArray(next), `Session ended before displaying ${phrase}`);
    }
  }
  await waitFor('manual> ');
  input.write('look availability\n');
  await waitFor('No busy time in this window');
  input.write(`look slots\nchoose ${afternoon}\nbook ${afternoon}\n`);
  await waitFor('Booking submitted');
  input.end();
  const trace = await ended;
  assert.equal(trace.end, 'input-closed');
  assert.match(transcript, /Session trace/u);
  assert.equal(trace.independentReadback.reservations, 1);
  assert.equal(trace.independentReadback.matchedNativeEvidence.reservation, false);
  assert.equal(trace.outcomes.visit, 'open');
  assert.deepEqual(trace.nativeReadCounts, { bill: 0, refund: 0, visit: 2 });
});

test('unknown session arguments show usage without starting the practice fixtures', async () => {
  await assert.rejects(run(process.execPath, [manualSession, 'some-unrecognized-option']), error => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /manual:session -- cold/u);
    assert.doesNotMatch(error.stderr, /some-unrecognized-option/u);
    assert.equal(error.stdout, '');
    return true;
  });
});
