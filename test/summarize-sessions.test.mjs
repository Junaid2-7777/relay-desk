import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/summarize-sessions.mjs', import.meta.url));
const evidence = sessions => ({ schemaVersion: 1, kind: 'synthetic-format-example', sessions });
const session = (number, ...runs) => ({ code: `s-${String(number).padStart(3, '0')}`, runs });
const cutoff = (point = 'first-morning-checkpoint', clock = '2026-11-23T09:00:00+05:30') => ({ point, clock });
const measurement = (arm, outcome, fields = {}) => ({ task: 'warm-monday', arm, outcome, cutoff: cutoff(), ...fields });

async function inputFile(t, input) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-summarize-worksheet-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'worksheet.json');
  await writeFile(filename, JSON.stringify(input));
  return filename;
}

test('reports observed task denominators and only compares matching participant and cutoff pairs', async t => {
  const input = evidence([
    session(101,
      measurement('fixed-rule', 'done', {
        unassistedSeconds: 32, counts: { setup: { consentChoices: 2, manualLookups: 0 }, ongoing: { manualLookups: 0, interruptions: 1 } }
      }),
      measurement('fixed-rule', 'done', {
        cutoff: cutoff('after-bill-decision'), unassistedSeconds: 220, counts: { ongoing: { manualLookups: 7, decisionsTaken: 1 } }
      }),
      measurement('manual', 'done', {
        cutoff: cutoff('first-morning-checkpoint', '2026-11-23T03:30:00Z'), unassistedSeconds: 65,
        counts: { setup: { consentChoices: 2, manualLookups: 1 }, ongoing: { manualLookups: 3, interruptions: 2, decisionsTaken: 0 } }
      })),
    session(102,
      measurement('fixed-rule', 'asked-for-help', { assisted: { outcome: 'done', elapsedSeconds: 30 } }),
      measurement('manual', 'asked-for-help', { unassistedSeconds: 12, assisted: { outcome: 'done', elapsedSeconds: 70 } })),
    session(103, measurement('fixed-rule', 'skipped'), measurement('manual', 'done', { unassistedSeconds: 45 })),
    session(104,
      measurement('fixed-rule', 'done', { unassistedSeconds: 58 }),
      measurement('manual', 'done', { cutoff: cutoff('first-morning-checkpoint', '2026-11-23T09:01:00+05:30'), unassistedSeconds: 48 })),
    session(105, measurement('fixed-rule', 'asked-for-help', { unassistedSeconds: 35 })),
    session(106, measurement('fixed-rule', 'stopped', { task: 'cold-monday', unassistedSeconds: 16 })),
    session(107,
      measurement('manual', 'cutoff', { task: 'cold-monday', unassistedSeconds: 40 }),
      measurement('fixed-rule', 'stopped', { cutoff: null, unassistedSeconds: 62 })),
    session(108,
      measurement('model-backed', 'done', { cutoff: cutoff('after-bill-decision') }),
      measurement('manual', 'done', { cutoff: cutoff('after-bill-decision') })),
    session(109,
      measurement('fixed-rule', 'done', { task: 'blank-desk', cutoff: cutoff('saved-check-after-restart') }),
      measurement('manual', 'stopped', { task: 'blank-desk', cutoff: cutoff('saved-check-after-restart') }))
  ]);
  const filename = await inputFile(t, input);
  const { stdout } = await run(process.execPath, [script, filename]);
  const report = JSON.parse(stdout);
  assert.equal(report.kind, 'synthetic-format-example');
  assert.equal(report.participants, 9);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), input);
  assert.ok(input.sessions.every(({ code }) => !stdout.includes(code)));

  const armSummary = (task, arm) => report.taskArms.find(item => item.task === task && item.arm === arm);
  const warmArm = armSummary('warm-monday', 'fixed-rule');
  assert.equal(warmArm.recordedParticipants, 6);
  assert.equal(warmArm.notRecorded, 3);
  const [warm, afterBill, unknown] = warmArm.cutoffs;
  assert.deepEqual(warm.cutoff, { point: 'first-morning-checkpoint', clock: '2026-11-23T03:30:00.000Z' });
  assert.equal(warm.recorded, 5);
  assert.equal(warm.attempted, 4);
  assert.equal(warm.notRecorded, 4);
  assert.deepEqual(warm.outcomes, {
    first: { done: 2, stopped: 0, cutoff: 0, 'asked-for-help': 2, skipped: 1 },
    afterHelp: { done: 1, stopped: 0, cutoff: 0 }, requestedHelpWithoutContinuation: 1
  });
  assert.deepEqual(warm.elapsedSeconds.unassisted.done, { n: 2, median: 45 });
  assert.deepEqual(warm.elapsedSeconds.unassisted['asked-for-help'], { n: 1, median: 35 });
  assert.deepEqual(warm.elapsedSeconds.assisted.done, { n: 1, median: 30 });
  assert.deepEqual(warm.counts.setup.consentChoices, { n: 1, median: 2 });
  assert.deepEqual(warm.counts.total.consentChoices, { n: 0, median: null });
  assert.deepEqual(warm.counts.total.manualLookups, { n: 1, median: 0 });
  assert.deepEqual(warm.counts.ongoing.decisionsTaken, { n: 0, median: null });
  assert.deepEqual(afterBill.cutoff, { point: 'after-bill-decision', clock: '2026-11-23T03:30:00.000Z' });
  assert.equal(afterBill.recorded, 1);
  assert.equal(afterBill.notRecorded, 8);
  assert.equal(afterBill.outcomes.first.skipped, 0);
  assert.deepEqual(afterBill.elapsedSeconds.unassisted.done, { n: 1, median: 220 });
  assert.deepEqual(afterBill.counts.ongoing.decisionsTaken, { n: 1, median: 1 });
  assert.equal(unknown.cutoff, null);
  assert.equal(unknown.outcomes.first.stopped, 1);
  assert.equal(unknown.notRecorded, 8);
  const manualLater = armSummary('warm-monday', 'manual').cutoffs[1];
  assert.deepEqual(manualLater.cutoff, { point: 'first-morning-checkpoint', clock: '2026-11-23T03:31:00.000Z' });
  assert.deepEqual(manualLater.elapsedSeconds.unassisted.done, { n: 1, median: 48 });
  assert.equal(armSummary('cold-monday', 'fixed-rule').cutoffs[0].outcomes.first.stopped, 1);
  assert.equal(armSummary('cold-monday', 'manual').cutoffs[0].outcomes.first.cutoff, 1);

  const pair = (task, arm) => report.deskManualPairs.find(item => item.task === task && item.deskArm === arm);
  const paired = pair('warm-monday', 'fixed-rule');
  assert.equal(paired.bothRecorded, 4);
  assert.equal(paired.bothAttempted, 3);
  assert.equal(paired.matchedCutoff, 2);
  assert.deepEqual(paired.completionPairs, { bothCompleted: 2, deskOnlyCompleted: 0, manualOnlyCompleted: 0, neitherCompleted: 0 });
  assert.deepEqual(paired.bothCompletedUnassisted.elapsedSeconds, { n: 1, deskMedian: 32, manualMedian: 65, medianDeskMinusManual: -33 });
  assert.deepEqual(paired.bothCompletedUnassisted.counts.total.manualLookups, { n: 1, deskMedian: 0, manualMedian: 4, medianDeskMinusManual: -4 });
  assert.deepEqual(paired.bothCompletedWithHelp.beforeHelpSeconds, { n: 0, deskMedian: null, manualMedian: null, medianDeskMinusManual: null });
  assert.deepEqual(paired.bothCompletedWithHelp.assistedSeconds, { n: 1, deskMedian: 30, manualMedian: 70, medianDeskMinusManual: -40 });
  assert.equal(pair('cold-monday', 'fixed-rule').matchedCutoff, 0);
  assert.equal(pair('warm-monday', 'model-backed').bothRecorded, 0);
  assert.equal(pair('warm-monday', 'model-backed').matchedCutoff, 0);
  const blank = pair('blank-desk', 'fixed-rule');
  assert.equal(blank.matchedCutoff, 1);
  assert.equal(blank.completionPairs.deskOnlyCompleted, 1);
  assert.equal(blank.bothCompletedUnassisted.elapsedSeconds.n, 0);
});

test('rejects private text and invalid worksheet rows without printing their contents', async t => {
  const allowed = measurement('fixed-rule', 'done');
  const invalid = [
    evidence([{ ...session(101, allowed), participantName: 'Private synthetic marker' }]),
    evidence([session(102, { ...allowed, cutoff: cutoff('first-morning-checkpoint', '2026-11-23T09:00:00') })]),
    evidence([session(103, { ...allowed, counts: { ongoing: { manualLookups: -1 } } })]),
    evidence([session(104, { ...allowed, assisted: { outcome: 'done', elapsedSeconds: 10 } })]),
    evidence([session(105, allowed, allowed)]),
    evidence([session(106, allowed, { ...allowed, cutoff: cutoff('first-morning-checkpoint', '2026-11-23T09:01:00+05:30') })])
  ];
  const filename = await inputFile(t, invalid[0]);
  for (const input of invalid) {
    await writeFile(filename, JSON.stringify(input));
    await assert.rejects(run(process.execPath, [script, filename]), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /Session 1/u);
      assert.ok(!error.stderr.includes('Private synthetic marker'));
      assert.ok(!error.stderr.includes(input.sessions[0].code));
      return true;
    });
  }
});
