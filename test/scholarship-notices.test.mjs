import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { replayNoticeCheckpoint } from '../src/scholarship/notices.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/replay-scholarship-notices.mjs', import.meta.url));
const fixtureUrl = new URL('../fixtures/scholarship/notices-replay.json', import.meta.url);

test('archived notice replay scores date history, source timing, conflicts and completed stages', async () => {
  const [{ stdout }, raw] = await Promise.all([run(process.execPath, [cli]), readFile(fixtureUrl)]);
  const report = JSON.parse(stdout);
  assert.equal(report.mode, 'archived-scholarship-notice-replay');
  assert.equal(report.caseEvidence, 'synthetic');
  assert.equal(report.fixtureSha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(report.passed, true);
  assert.equal(report.scenarios.flatMap(scenario => scenario.checkpoints).length, 21);
  assert.ok(report.scenarios.flatMap(scenario => scenario.checkpoints).every(checkpoint => checkpoint.passed));

  const repost = report.scenarios.find(scenario => scenario.id === 'D02-older-repost').checkpoints.at(-1);
  const [prior] = repost.evidence.milestones.L1.history[0].evidence;
  assert.equal(prior.issuedOn, '2026-10-01');
  assert.equal(prior.availableOn, '2026-11-21');
  assert.equal(prior.origin, 'archived');
  assert.equal(repost.evidence.milestones.L1.evidence[0].id, 'pib-2330936');

  const capture = report.scenarios.find(scenario => scenario.id === 'D02-availability-and-scope').checkpoints[3];
  const [nsp] = capture.evidence.milestones.L1.corroboration;
  assert.equal(nsp.capturedOn, '2026-11-21');
  assert.equal(nsp.issuedOn, null);
  assert.equal(nsp.url, 'https://scholarships.gov.in/All-Scholarships');

  const conflict = report.scenarios.find(scenario => scenario.id === 'D03-independent-field-conflict').checkpoints[1];
  assert.ok(conflict.evidence.milestones.L1.review.evidence.every(item => item.origin === 'synthetic' && item.url === null));
  const completed = report.scenarios.find(scenario => scenario.id === 'D10-already-verified-stage').checkpoints;
  assert.deepEqual(completed[1].evidence.followups.L1, completed[2].evidence.followups.L1);
  assert.equal(completed[2].evidence.followups.L1.proof.receiptRef, 'practice-school-proof');
});

test('capture dates cannot settle a disagreement and independently verified stages still require a receipt', async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl));
  const scope = fixture.scopes.practice;
  const captureSource = { scope, issuer: 'practice-portal', kind: 'capture', origin: 'synthetic', stages: ['L1'] };
  const releaseSource = { scope, issuer: scope.issuer, kind: 'release', origin: 'synthetic', stages: ['L1'] };
  const capture = {
    id: 'practice-first-capture', source: 'capture', scope, issuer: captureSource.issuer, kind: captureSource.kind,
    capturedOn: '2026-10-01', availableOn: '2026-10-01', dates: { L1: '2026-11-15' }, url: null, locator: 'First synthetic capture'
  };
  const conflictingCapture = {
    ...capture, id: 'practice-new-capture', capturedOn: '2026-10-31', availableOn: '2026-10-31', dates: { L1: '2026-11-30' }
  };
  const authoritativeRelease = {
    id: 'practice-authoritative-resolution', source: 'release', scope, issuer: releaseSource.issuer, kind: releaseSource.kind,
    issuedOn: '2026-11-21', publishedOn: '2026-11-21', availableOn: '2026-11-21', dates: { L1: '2026-11-30' },
    url: null, locator: 'Synthetic dated resolution'
  };
  const checkpoint = {
    scope, sources: { capture: captureSource, release: releaseSource }, caseScope: fixture.case,
    asOf: '2026-11-21T12:00:00+05:30', receipts: [fixture.caseReceipts.filed]
  };

  const contested = replayNoticeCheckpoint({ ...checkpoint, notices: [conflictingCapture, capture] });
  assert.equal(contested.milestones.L1.date, '2026-11-15');
  assert.equal(contested.milestones.L1.review.code, 'capture-disagreement');
  assert.deepEqual(contested.milestones.L1.review.evidence.map(item => item.id), [capture.id, conflictingCapture.id]);
  assert.equal(contested.followups.L1.status, 'review');

  const resolved = replayNoticeCheckpoint({ ...checkpoint, notices: [conflictingCapture, capture, authoritativeRelease] });
  assert.equal(resolved.milestones.L1.date, '2026-11-30');
  assert.equal(resolved.milestones.L1.review, null);
  assert.equal(resolved.case.owner, 'institute');
  assert.equal(resolved.case.instituteProof, null);
  assert.equal(resolved.followups.L1.status, 'upcoming');
});

test('notice replay refuses an ambiguous clock and defers receipts from the future', async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl));
  const input = {
    scope: fixture.scopes.nmmss, sources: {}, notices: [], caseScope: fixture.case,
    receipts: [fixture.caseReceipts.filed, fixture.caseReceipts.school]
  };
  for (const asOf of ['2026-10-30T08:59:59', '2026-11-31T08:59:59+05:30']) {
    assert.throws(() => replayNoticeCheckpoint({ ...input, asOf }), /real date and explicit timezone/u);
  }
  const before = replayNoticeCheckpoint({ ...input, asOf: '2026-10-30T08:59:59+05:30' });
  assert.equal(before.case.owner, 'institute');
  assert.equal(before.case.instituteProof, null);
  const at = replayNoticeCheckpoint({ ...input, asOf: '2026-10-30T09:00:00+05:30' });
  assert.equal(at.case.owner, 'district');
  assert.deepEqual(at.case.instituteProof, fixture.caseReceipts.school);
});
