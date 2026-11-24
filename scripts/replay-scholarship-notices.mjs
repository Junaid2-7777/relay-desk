import { readFile } from 'node:fs/promises';
import { zonedInstant } from '../shared/evidence-time.mjs';
import { replayNoticeCheckpoint } from '../src/scholarship/notices.mjs';
import { gradeCheckpoint, writeReplayReport } from './scholarship-replay-support.mjs';

const mode = 'archived-scholarship-notice-replay';
const fixtureFile = new URL('../fixtures/scholarship/notices-replay.json', import.meta.url);
const required = ['day', 'owner', 'caseStage', 'dates', 'followups'];

function registered(table, id) {
  if (!Object.hasOwn(table, id)) throw new TypeError(`Unknown scholarship replay record ${id}.`);
  return table[id];
}

function deliveredNotice(fixture, sources, id) {
  const variant = Object.hasOwn(fixture.syntheticDeliveries, id) ? fixture.syntheticDeliveries[id] : null;
  const recordId = variant?.record ?? id;
  const record = registered(fixture.notices, recordId);
  const source = registered(sources, record.source);
  const overrides = variant?.changes ?? {};
  return {
    ...record, issuer: source.issuer, scope: source.scope, kind: source.kind,
    id: variant?.keepRecordId ? recordId : id,
    availableOn: record.publishedOn ?? record.capturedOn,
    ...overrides,
    ...(overrides.scope ? { scope: { ...source.scope, ...overrides.scope } } : {})
  };
}

function observations({ day, case: caseState, milestones, ignored, followups }) {
  const { L1, L2 } = milestones;
  return {
    day, owner: caseState.owner, caseStage: caseState.stage,
    dates: Object.fromEntries(Object.entries(milestones).map(([stage, field]) => [stage, field.date])),
    followups: Object.fromEntries(Object.entries(followups).map(([stage, field]) => [stage, field.status])),
    followupDates: Object.fromEntries(Object.entries(followups).map(([stage, field]) => [stage, field.date])),
    proofIds: { L1: caseState.instituteProof?.id ?? null, L2: caseState.districtProof?.id ?? null },
    L1Versions: L1.evidence.map(item => item.id), L2Versions: L2.evidence.map(item => item.id),
    L1History: L1.history.flatMap(revision => revision.evidence.map(record => record.id)),
    L2History: L2.history.flatMap(revision => revision.evidence.map(record => record.id)),
    L1Corroboration: L1.corroboration.map(item => item.id),
    L1Conflict: L1.review?.evidence.map(item => item.id) ?? [],
    ignored
  };
}

function replayScenario(fixture, sources, { id, scope: scopeId, checkpoints }) {
  if (typeof id !== 'string' || !id || !Array.isArray(checkpoints) || !checkpoints.length) {
    throw new TypeError('Each notice scenario must have an ID and at least one checkpoint.');
  }
  const scope = registered(fixture.scopes, scopeId);
  const notices = [];
  const receipts = [];
  let previousInstant = -Infinity;
  const results = checkpoints.map(({ label, asOf, observe, deliver, expected }) => {
    if (typeof label !== 'string' || !label || !Array.isArray(observe) || !Array.isArray(deliver)) {
      throw new TypeError(`An invalid checkpoint appears in scenario ${id}.`);
    }
    const instant = zonedInstant(asOf);
    if (!Number.isFinite(instant) || instant < previousInstant) throw new TypeError(`Invalid replay clock at ${label}.`);
    previousInstant = instant;
    notices.push(...observe.map(key => deliveredNotice(fixture, sources, key)));
    receipts.push(...deliver.map(key => registered(fixture.caseReceipts, key)));
    const state = replayNoticeCheckpoint({ scope, sources, notices, asOf, caseScope: fixture.case, receipts });
    const observed = observations(state);
    const evidence = { milestones: state.milestones, followups: state.followups };
    return gradeCheckpoint({ label, asOf, observe, deliver, expected, observed, evidence, required });
  });
  return { id, scope, checkpoints: results, passed: results.every(checkpoint => checkpoint.passed) };
}

async function main(args) {
  if (args.length) throw new TypeError('Usage: node scripts/replay-scholarship-notices.mjs');
  const raw = await readFile(fixtureFile);
  const fixture = JSON.parse(raw);
  if (fixture.schemaVersion !== 1 || fixture.mode !== mode || !Array.isArray(fixture.scenarios) || !fixture.scenarios.length) {
    throw new TypeError('Expected the version 1 archived notice replay fixture.');
  }
  const sources = Object.fromEntries(Object.entries(fixture.sources).map(([id, source]) => [id, {
    ...source, scope: registered(fixture.scopes, source.scope)
  }]));
  const scenarios = fixture.scenarios.map(scenario => replayScenario(fixture, sources, scenario));
  writeReplayReport(mode, raw, scenarios, { caseId: fixture.case.caseId, caseEvidence: 'synthetic' });
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`Scholarship notice replay: ${error.message}\n`);
  process.exitCode = 1;
}
