import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openReceiptFixture, practiceReceiptSource } from '../src/receipt-fixture.mjs';
import { ReceiptPlanError, matchingReceipt, normalizeReceiptPlan, runReceipt } from '../src/receipt.mjs';

const occurredAt = '2026-11-23T11:00:00+05:30';
const now = new Date('2026-11-23T06:00:00Z');
const practicePlan = { issuer: practiceReceiptSource.issuer, subject: 'membership-207', type: 'membership', status: 'closed' };
const closure = { ...practicePlan, id: 'closure-1', occurredAt };

function setup(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-receipt-'));
  const fixture = openReceiptFixture({ dataDir, clock: () => now });
  t.after(() => {
    fixture.close();
    rmSync(dataDir, { force: true, recursive: true });
  });
  fixture.reset();
  return fixture;
}

test('a scoped read excludes other issuers and subjects and rejects unregistered access', t => {
  const fixture = setup(t);
  fixture.putSource({ issuer: 'another-library', label: 'Another library' });
  fixture.putReceipt(closure);
  fixture.putReceipt({ ...closure, issuer: 'another-library' });
  fixture.putReceipt({ ...closure, id: 'unrelated-1', subject: 'unrelated-account' });

  assert.deepEqual(fixture.read(practicePlan), [closure]);
  assert.throws(() => fixture.read({ ...practicePlan, issuer: 'unavailable' }), ReceiptPlanError);
  assert.deepEqual(fixture.inspect().reads, [{ issuer: practicePlan.issuer, subject: practicePlan.subject, checkedAt: now.toISOString() }]);
});

test('only one exact independent receipt can verify the plan', () => {
  const plan = normalizeReceiptPlan(practicePlan, [practiceReceiptSource]);
  const noise = [
    { ...closure, issuer: 'another-library' },
    { ...closure, subject: 'another-membership' },
    { ...closure, type: 'acknowledgement' },
    { ...closure, status: 'pending' },
    { ...closure, occurredAt: '2026-11-23T11:00:00' },
    { ...closure, occurredAt: '2026-11-31T11:00:00Z' }
  ];
  assert.equal(matchingReceipt(plan, noise), null);
  assert.equal(matchingReceipt(plan, [...noise, closure]), closure);
  assert.equal(matchingReceipt(plan, [closure, { ...closure, id: 'closure-2' }]), null);

  const unregistered = normalizeReceiptPlan(practicePlan);
  assert.equal(unregistered.available, false);
  assert.equal(matchingReceipt(unregistered, [closure]), null);
  assert.throws(() => normalizeReceiptPlan({ ...practicePlan, subject: '' }), ReceiptPlanError);
});

test('grant and proof changes are respected and an unavailable issuer stays open', t => {
  const fixture = setup(t);
  const plan = normalizeReceiptPlan(practicePlan, fixture.sources());
  let record = { id: 'custom-errand', status: 'open', receiptPlan: plan, grants: {} };
  const journal = { dispatch: (id, action) => action(record) };
  assert.equal(runReceipt(record, fixture, journal, now).issue, 'receipt-permission');
  assert.equal(fixture.inspect().reads.length, 0);

  const grant = {
    operation: 'receipt', status: 'allowed', revision: 1, expiresAt: '2026-11-24T06:00:00Z',
    scope: { issuer: plan.issuer, subject: plan.subject }
  };
  record = { ...record, grants: { receipt: grant } };
  const staleJournal = { dispatch: (id, action) => action({ ...record, grants: { receipt: { ...grant, revision: 2 } } }) };
  assert.equal(runReceipt(record, fixture, staleJournal, now).issue, 'receipt-permission');
  assert.equal(fixture.inspect().reads.length, 0);

  fixture.putReceipt({ ...closure, id: 'acknowledgement-1', status: 'submitted' });
  const waiting = runReceipt(record, fixture, journal, now);
  assert.equal(waiting.issue, 'receipt-pending');
  assert.deepEqual(waiting.receiptCheck, { checkedAt: now.toISOString(), lastEventAt: occurredAt });
  fixture.putReceipt(closure);
  assert.deepEqual(runReceipt(record, fixture, journal, now).receiptProof, closure);
  const unavailable = { ...record, receiptPlan: { ...plan, issuer: 'unavailable' } };
  assert.equal(runReceipt(unavailable, fixture, journal, now).issue, 'evidence-needed');
  assert.equal(fixture.inspect().reads.length, 2);
});
