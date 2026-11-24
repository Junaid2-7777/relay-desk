import { readFile } from 'node:fs/promises';
import { foldScholarshipCase } from '../src/scholarship/authority.mjs';
import { gradeCheckpoint, writeReplayReport } from './scholarship-replay-support.mjs';

const mode = 'synthetic-scholarship-case-events';
const defaultFixture = new URL('../fixtures/scholarship/authority-replay.json', import.meta.url);

function observedFields(state) {
  return {
    sequence: state.sequence,
    stage: state.stage,
    owner: state.owner,
    review: state.review?.code ?? null,
    missingSequence: state.review?.code === 'sequence-gap' ? state.review.sequence : null,
    returnId: state.correction?.request.id ?? null,
    correctionReason: state.correction?.request.reason ?? null,
    submissionId: state.correction?.submission?.id ?? null,
    acknowledgementId: state.correction?.acknowledgement?.id ?? null,
    awaitingAcknowledgement: state.awaitingAcknowledgement,
    historicalAcknowledgementIds: state.historicalAcknowledgements.map(receipt => receipt.id),
    instituteProofId: state.instituteProof?.id ?? null,
    districtProofId: state.districtProof?.id ?? null
  };
}

function replayScenario(caseScope, events, { id, checkpoints }) {
  if (typeof id !== 'string' || !id || !Array.isArray(checkpoints) || !checkpoints.length) {
    throw new TypeError('Each scenario must have an ID and at least one checkpoint.');
  }
  const deliveries = [];
  const results = checkpoints.map(({ label, deliver, expected }) => {
    if (typeof label !== 'string' || !label || !Array.isArray(deliver) ||
        !deliver.every(key => typeof key === 'string' && Object.hasOwn(events, key))) {
      throw new TypeError(`An invalid delivery batch appears in scenario ${id}.`);
    }
    deliveries.push(...deliver.map(key => events[key]));
    const state = foldScholarshipCase(caseScope, deliveries);
    const observed = observedFields(state);
    return gradeCheckpoint({ label, deliver, expected, observed, required: ['sequence', 'stage', 'owner', 'review'] });
  });
  return { id, checkpoints: results, passed: results.every(checkpoint => checkpoint.passed) };
}

async function main(args) {
  if (args.length > 1) throw new TypeError('Usage: node scripts/replay-scholarship.mjs [fixture.json]');
  const raw = await readFile(args[0] ?? defaultFixture);
  const fixture = JSON.parse(raw);
  if (fixture?.schemaVersion !== 1 || fixture.mode !== mode || !fixture.events || Array.isArray(fixture.events) ||
      typeof fixture.events !== 'object' || !Array.isArray(fixture.scenarios) || !fixture.scenarios.length) {
    throw new TypeError('Provide a version 1 synthetic scholarship case-event fixture.');
  }
  const scenarios = fixture.scenarios.map(scenario => replayScenario(fixture.case, fixture.events, scenario));
  writeReplayReport(mode, raw, scenarios, { caseId: fixture.case.caseId });
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`Scholarship replay: ${error.message}\n`);
  process.exitCode = 1;
}
