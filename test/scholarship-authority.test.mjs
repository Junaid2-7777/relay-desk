import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { foldScholarshipCase } from '../src/scholarship/authority.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/replay-scholarship.mjs', import.meta.url));
const fixtureUrl = new URL('../fixtures/scholarship/authority-replay.json', import.meta.url);

test('scholarship replay grades each authored checkpoint separately from the household suite', async () => {
  const [{ stdout }, raw] = await Promise.all([run(process.execPath, [script]), readFile(fixtureUrl)]);
  const report = JSON.parse(stdout);
  assert.equal(report.mode, 'synthetic-scholarship-case-events');
  assert.equal(report.pinnedSpecification, 'e7b729d64489d5622118d55c8d9664f35bf3a9f0');
  assert.equal(report.fixtureSha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(report.passed, true);
  const fixture = JSON.parse(raw);
  assert.deepEqual(report.scenarios.map(scenario => scenario.id), fixture.scenarios.map(scenario => scenario.id));
  assert.equal(report.scenarios.flatMap(scenario => scenario.checkpoints).length, 27);
  assert.ok(report.scenarios.flatMap(scenario => scenario.checkpoints).every(checkpoint => checkpoint.passed));
});

test('scholarship replay exits nonzero and identifies any checkpoint expectation mismatch', async t => {
  const fixture = JSON.parse(await readFile(fixtureUrl));
  fixture.scenarios[0].checkpoints[0].expected.stage = 'verified';
  const folder = await mkdtemp(join(tmpdir(), 'relay-scholarship-replay-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const filename = join(folder, 'fixture.json');
  await writeFile(filename, JSON.stringify(fixture));

  await assert.rejects(run(process.execPath, [script, filename]), error => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.passed, false);
    const [first] = report.scenarios[0].checkpoints;
    assert.equal(first.expected.stage, 'verified');
    assert.equal(first.observed.stage, 'L1');
    assert.deepEqual(first.mismatches, ['stage']);
    return true;
  });
});

test('the case fold preserves original authority receipts and folds by service sequence', async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl));
  const { filed, school, district } = fixture.events;
  const earlyClock = { ...district, recordedAt: '2026-11-24T04:31:00Z' };
  const sameSchool = Object.fromEntries(Object.entries(school).toReversed());
  const deliveries = Object.freeze([filed, earlyClock, school, sameSchool].map(Object.freeze));
  const input = structuredClone(deliveries);

  const state = foldScholarshipCase(fixture.case, deliveries);
  assert.equal(state.stage, 'verified');
  assert.equal(state.review, null);
  assert.equal(state.sequence, 3);
  assert.deepEqual(state.instituteProof, school);
  assert.deepEqual(state.districtProof, earlyClock);
  assert.deepEqual(deliveries, input);

  const conflict = { ...school, receiptRef: 'another-practice-receipt' };
  const blocked = foldScholarshipCase(fixture.case, [filed, school, conflict, district]);
  assert.equal(blocked.stage, 'L2');
  assert.equal(blocked.owner, 'district');
  assert.deepEqual(blocked.review, { code: 'conflicting-event-id', eventId: school.id, sequence: school.sequence });
  assert.deepEqual(blocked.instituteProof, school);
  assert.equal(blocked.districtProof, null);
});
