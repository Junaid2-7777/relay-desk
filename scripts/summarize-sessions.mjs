import { readFile } from 'node:fs/promises';
import { zonedInstant } from '../shared/evidence-time.mjs';

const cutoffs = {
  'blank-desk': ['saved-check-after-restart'],
  'cold-monday': ['first-morning-checkpoint'],
  'warm-monday': ['first-morning-checkpoint', 'after-bill-decision']
};
const arms = ['manual', 'fixed-rule', 'model-backed'];
const kinds = ['observed-participant-sessions', 'synthetic-format-example'];
const terminal = ['done', 'stopped', 'cutoff'];
const firstOutcomes = [...terminal, 'asked-for-help', 'skipped'];
const phases = ['setup', 'ongoing', 'total'];
const measures = ['consentChoices', 'clarifications', 'decisionsPresented', 'decisionsTaken', 'manualLookups', 'repeatPrompts', 'interruptions'];

class WorksheetError extends Error {}

function shape(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function seconds(value) {
  return value == null || (typeof value === 'number' && value >= 0 && value <= Number.MAX_SAFE_INTEGER);
}

function counts(value, label) {
  if (value == null) return {};
  if (!shape(value, [], phases.slice(0, 2))) throw new WorksheetError(`${label} must use setup and ongoing counts.`);
  for (const phase of phases.slice(0, 2)) {
    if (value[phase] == null) continue;
    if (!shape(value[phase], [], measures) || Object.values(value[phase]).some(count =>
      count !== null && (!Number.isSafeInteger(count) || count < 0))) {
      throw new WorksheetError(`${label} has an unknown measure or an invalid count.`);
    }
  }
  const total = {};
  for (const measure of measures) {
    const setup = value.setup?.[measure];
    const ongoing = value.ongoing?.[measure];
    if (setup == null || ongoing == null) continue;
    total[measure] = setup + ongoing;
    if (!Number.isSafeInteger(total[measure])) throw new WorksheetError(`${label} has a count outside the supported range.`);
  }
  return { setup: value.setup, ongoing: value.ongoing, total };
}

function normalizeRun(value, label) {
  if (!shape(value, ['task', 'arm', 'outcome'], ['cutoff', 'unassistedSeconds', 'assisted', 'counts']) ||
      typeof value.task !== 'string' || !Object.hasOwn(cutoffs, value.task) || !arms.includes(value.arm) ||
      !firstOutcomes.includes(value.outcome) || !seconds(value.unassistedSeconds)) {
    throw new WorksheetError(`${label} must use documented task, arm, outcome and timing fields.`);
  }
  let cutoff = null;
  if (value.cutoff != null) {
    if (!shape(value.cutoff, ['point', 'clock']) || !cutoffs[value.task].includes(value.cutoff.point) ||
        !Number.isFinite(zonedInstant(value.cutoff.clock))) {
      throw new WorksheetError(`${label} has an invalid cutoff point or fixture clock.`);
    }
    cutoff = { point: value.cutoff.point, instant: zonedInstant(value.cutoff.clock) };
  }
  if (value.assisted != null && (value.outcome !== 'asked-for-help' ||
      !shape(value.assisted, ['outcome'], ['elapsedSeconds']) || !terminal.includes(value.assisted.outcome) ||
      !seconds(value.assisted.elapsedSeconds))) {
    throw new WorksheetError(`${label} has an invalid assisted continuation.`);
  }
  if (value.outcome === 'skipped' && (value.unassistedSeconds != null || value.counts != null)) {
    throw new WorksheetError(`${label} marks a skipped task with timing or workload.`);
  }
  return { ...value, cutoff, counts: counts(value.counts, label) };
}

function worksheets(input) {
  if (!shape(input, ['schemaVersion', 'kind', 'sessions']) || input.schemaVersion !== 1 || !kinds.includes(input.kind) ||
      !Array.isArray(input.sessions)) {
    throw new WorksheetError('Use the version 1 participant session format and label its evidence kind.');
  }
  const seen = new Set();
  return input.sessions.map((session, sessionIndex) => {
    const label = `Session ${sessionIndex + 1}`;
    if (!shape(session, ['code', 'runs']) || typeof session.code !== 'string' || !/^s-[0-9]{3,8}$/u.test(session.code) ||
        seen.has(session.code) || !Array.isArray(session.runs)) {
      throw new WorksheetError(`${label} needs a unique anonymous code and task records.`);
    }
    seen.add(session.code);
    const runs = new Map();
    session.runs.forEach((value, index) => {
      const run = normalizeRun(value, `${label}, task record ${index + 1}`);
      const key = `${run.task}/${run.arm}`;
      if (runs.has(key)) throw new WorksheetError(`${label} contains more than one record for a task and arm.`);
      runs.set(key, run);
    });
    return runs;
  });
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function observed(values) {
  const present = values.filter(value => value != null);
  return { n: present.length, median: median(present) };
}

function workload(describe) {
  return Object.fromEntries(phases.map(phase => [phase,
    Object.fromEntries(measures.map(measure => [measure, describe(run => run.counts[phase]?.[measure])]))
  ]));
}

function outcomes(runs) {
  const first = Object.fromEntries(firstOutcomes.map(outcome => [outcome, runs.filter(run => run.outcome === outcome).length]));
  const afterHelp = Object.fromEntries(terminal.map(outcome => [outcome, runs.filter(run => run.assisted?.outcome === outcome).length]));
  return { first, afterHelp, requestedHelpWithoutContinuation: first['asked-for-help'] - Object.values(afterHelp).reduce((sum, count) => sum + count, 0) };
}

function armSummary(sessions, task, arm) {
  const runs = sessions.map(session => session.get(`${task}/${arm}`)).filter(Boolean);
  const attempted = runs.filter(run => run.outcome !== 'skipped');
  const unassisted = [...terminal, 'asked-for-help'].map(outcome => [outcome,
    observed(attempted.filter(run => run.outcome === outcome).map(run => run.unassistedSeconds))]);
  const assisted = terminal.map(outcome => [outcome,
    observed(attempted.filter(run => run.assisted?.outcome === outcome).map(run => run.assisted.elapsedSeconds))]);
  return {
    task, arm, recorded: runs.length, attempted: attempted.length, notRecorded: sessions.length - runs.length,
    outcomes: outcomes(runs), elapsedSeconds: { unassisted: Object.fromEntries(unassisted), assisted: Object.fromEntries(assisted) },
    counts: workload(read => observed(attempted.map(read)))
  };
}

function pairStats(pairs, read) {
  const values = pairs.map(pair => pair.map(read)).filter(([desk, manual]) => desk != null && manual != null);
  return {
    n: values.length, deskMedian: median(values.map(([desk]) => desk)), manualMedian: median(values.map(([, manual]) => manual)),
    medianDeskMinusManual: median(values.map(([desk, manual]) => desk - manual))
  };
}

const completed = run => run.outcome === 'done' || run.assisted?.outcome === 'done';

function pairSummary(sessions, task, deskArm) {
  const recorded = sessions.map(session => [session.get(`${task}/${deskArm}`), session.get(`${task}/manual`)])
    .filter(pair => pair.every(Boolean));
  const attempted = recorded.filter(pair => pair.every(run => run.outcome !== 'skipped'));
  const matched = attempted.filter(([desk, manual]) => desk.cutoff?.point === cutoffs[task][0] &&
    manual.cutoff?.point === desk.cutoff.point && manual.cutoff.instant === desk.cutoff.instant);
  const unassisted = matched.filter(pair => pair.every(run => run.outcome === 'done'));
  const assisted = matched.filter(pair => pair.every(run => run.assisted?.outcome === 'done'));
  const completionPairs = { bothCompleted: 0, deskOnlyCompleted: 0, manualOnlyCompleted: 0, neitherCompleted: 0 };
  for (const [desk, manual] of matched) {
    if (completed(desk) && completed(manual)) completionPairs.bothCompleted++;
    else if (completed(desk)) completionPairs.deskOnlyCompleted++;
    else if (completed(manual)) completionPairs.manualOnlyCompleted++;
    else completionPairs.neitherCompleted++;
  }
  return {
    task, deskArm, bothRecorded: recorded.length, bothAttempted: attempted.length,
    matchedCutoff: matched.length, completionPairs,
    outcomes: { desk: outcomes(matched.map(([desk]) => desk)), manual: outcomes(matched.map(([, manual]) => manual)) },
    bothCompletedUnassisted: {
      n: unassisted.length, elapsedSeconds: pairStats(unassisted, run => run.unassistedSeconds),
      counts: workload(read => pairStats(unassisted, read))
    },
    bothCompletedWithHelp: {
      n: assisted.length, beforeHelpSeconds: pairStats(assisted, run => run.unassistedSeconds),
      assistedSeconds: pairStats(assisted, run => run.assisted.elapsedSeconds),
      counts: workload(read => pairStats(assisted, read))
    }
  };
}

async function main(args) {
  if (args.length !== 1 || args[0].startsWith('--')) {
    throw new WorksheetError('Use npm run --silent summarize:sessions -- INPUT.json.');
  }
  const input = JSON.parse(await readFile(args[0], 'utf8'));
  const sessions = worksheets(input);
  const tasks = Object.keys(cutoffs);
  console.log(JSON.stringify({
    schemaVersion: 1, kind: input.kind, participants: sessions.length,
    taskArms: tasks.flatMap(task => arms.map(arm => armSummary(sessions, task, arm))),
    deskManualPairs: tasks.flatMap(task => arms.slice(1).map(arm => pairSummary(sessions, task, arm)))
  }, null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof WorksheetError ? error.message : 'Could not read a valid participant worksheet JSON file.');
  process.exitCode = 1;
}
