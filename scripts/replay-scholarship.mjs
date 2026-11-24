import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { foldScholarshipCase } from '../src/scholarship/authority.mjs';

const mode = 'synthetic-scholarship-case-events';
const pinnedSpecification = 'e7b729d64489d5622118d55c8d9664f35bf3a9f0';
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
    if (!expected || !['sequence', 'stage', 'owner', 'review'].every(key => Object.hasOwn(expected, key)) ||
        !Object.keys(expected).every(key => Object.hasOwn(observed, key))) {
      throw new TypeError(`Invalid expected evidence in scenario ${id}, checkpoint ${label}.`);
    }
    const mismatches = Object.keys(expected).filter(key => !isDeepStrictEqual(observed[key], expected[key]));
    return { label, deliver, expected, observed, mismatches, passed: mismatches.length === 0 };
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
  const git = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true
  });
  const passed = scenarios.every(scenario => scenario.passed);
  process.stdout.write(`${JSON.stringify({
    mode, pinnedSpecification, repositoryRevision: git.status === 0 ? git.stdout.trim() : null,
    caseId: fixture.case.caseId, fixtureSha256: createHash('sha256').update(raw).digest('hex'), scenarios, passed
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`Scholarship replay: ${error.message}\n`);
  process.exitCode = 1;
}
