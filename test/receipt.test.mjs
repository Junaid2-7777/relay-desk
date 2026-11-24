import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDesk } from '../src/desk.mjs';
import { openReceiptFixture, practiceReceiptSource } from '../src/receipt-fixture.mjs';
import { ReceiptPlanError, checkReceipt, matchingReceipt, normalizeReceiptPlan, runReceipt } from '../src/receipt.mjs';

const occurredAt = '2026-11-23T11:00:00+05:30';
const now = new Date('2026-11-23T06:00:00Z');
const practicePlan = { issuer: practiceReceiptSource.issuer, subject: 'membership-207', type: 'membership', status: 'closed' };
const closure = { ...practicePlan, id: 'closure-1', occurredAt };

function setup(t, clock = () => now) {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-receipt-'));
  const fixture = openReceiptFixture({ dataDir, clock });
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

test('an issuer read cannot retry under a grant that expired after the first attempt', t => {
  const fixture = setup(t);
  fixture.setAvailable(practicePlan.issuer, false);
  const expiresAt = new Date(+now + 1000);
  const plan = normalizeReceiptPlan(practicePlan, fixture.sources());
  const record = {
    status: 'open', receiptPlan: plan, grants: {
      receipt: { operation: 'receipt', status: 'allowed', revision: 1, expiresAt: expiresAt.toISOString(),
        scope: { issuer: plan.issuer, subject: plan.subject } }
    }
  };
  const times = [now, now, expiresAt];
  const checked = checkReceipt(record, fixture, () => times.shift());
  assert.equal(checked.issue, 'receipt-permission');
  assert.equal(checked.receiptProof, null);
  assert.equal(fixture.inspect().reads.length, 1);
  assert.equal(fixture.inspect().reads[0].status, 'unavailable');
  fixture.reset();
  assert.deepEqual(fixture.read(plan), []);
});

test('a receipt grant expiring as the provider starts the read prevents even the native lookup', t => {
  const fixture = setup(t);
  fixture.putReceipt(closure);
  const expiresAt = new Date(+now + 1000);
  let time = now;
  const plan = normalizeReceiptPlan(practicePlan, fixture.sources());
  const record = {
    status: 'open', receiptPlan: plan, grants: {
      receipt: { operation: 'receipt', status: 'allowed', revision: 1, expiresAt: expiresAt.toISOString(),
        scope: { issuer: plan.issuer, subject: plan.subject } }
    }
  };
  const delayed = {
    ...fixture,
    readForCheck(...args) {
      time = expiresAt;
      return fixture.readForCheck(...args);
    }
  };
  const checked = checkReceipt(record, delayed, () => time);
  assert.equal(checked.issue, 'receipt-permission');
  assert.equal(checked.receiptProof, null);
  assert.deepEqual(fixture.inspect().reads, []);
});

test('the provider checks permission at the timestamp it would record for the issuer lookup', t => {
  const expiresAt = new Date(+now + 1);
  const fixture = setup(t, () => expiresAt);
  fixture.putReceipt(closure);
  const plan = normalizeReceiptPlan(practicePlan, fixture.sources());
  const record = { status: 'open', receiptPlan: plan, grants: { receipt: {
    operation: 'receipt', status: 'allowed', revision: 1, expiresAt: expiresAt.toISOString(),
    scope: { issuer: plan.issuer, subject: plan.subject }
  } } };
  const result = checkReceipt(record, fixture, () => now);
  assert.equal(result.issue, 'receipt-permission');
  assert.equal(result.receiptProof, null);
  assert.deepEqual(fixture.inspect().reads, []);
});

function interruptedDesk(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-interrupted-receipt-'));
  let time = now;
  const clock = () => time;
  const fixture = openReceiptFixture({ dataDir, clock });
  fixture.reset();
  const household = { receipt: { fixture, run: checkReceipt } };
  const open = () => openDesk({ dataDir, clock, household });
  let desk = open();
  t.after(() => {
    desk.close();
    fixture.close();
    rmSync(dataDir, { force: true, recursive: true });
  });
  const saved = desk.save({ note: 'Check my practice membership.' });
  const plan = desk.setup(saved.id, { ...practicePlan, revision: saved.revision, capability: 'receipt' });
  const record = desk.householdAccess(saved.id, { revision: plan.revision, operation: 'receipt', choice: 'allowed' });
  const interruptedCheckpoint = 'interrupted-native-check';
  return {
    fixture, record,
    get desk() { return desk; },
    moveTime(next) { time = next; },
    interruptAndReopen() {
      const injector = new DatabaseSync(join(dataDir, 'desk.sqlite'));
      try {
        injector.exec(`CREATE TRIGGER interrupt_receipt_check BEFORE INSERT ON receipt_checkpoints
          BEGIN SELECT RAISE(ABORT, 'Simulated interruption after provider receipt read'); END`);
        assert.throws(() => desk.checkpoint(interruptedCheckpoint), /Simulated interruption/);
        desk.close();
        injector.exec('DROP TRIGGER interrupt_receipt_check');
        desk = open();
      } finally {
        injector.close();
      }
    },
    replay: () => desk.checkpoint(interruptedCheckpoint).errands[0]
  };
}

test('an interrupted named checkpoint preserves its native attempt budget across reconnect and restart', t => {
  const scenario = interruptedDesk(t);
  const { fixture } = scenario;
  fixture.setAvailable(practicePlan.issuer, false);
  scenario.interruptAndReopen();
  const attempts = fixture.inspect().reads;
  assert.deepEqual(attempts.map(({ status }) => status), ['unavailable', 'unavailable']);

  fixture.setAvailable(practicePlan.issuer, true);
  fixture.putReceipt(closure);
  assert.equal(scenario.replay().issue, 'receipt-unavailable');
  assert.deepEqual(fixture.inspect().reads, attempts);
  const fresh = scenario.desk.checkpoint('fresh-receipt-read').errands[0];
  assert.deepEqual(fresh.receiptProof, closure);
  assert.equal(fixture.inspect().reads.length, 3);
});

test('a named checkpoint cannot replay an issuer read from after the rewound clock', t => {
  const scenario = interruptedDesk(t);
  const { fixture, record } = scenario;
  const receipt = { ...closure, occurredAt: '2026-11-23T07:00:00Z' };
  const later = new Date('2026-11-23T08:00:00Z');
  scenario.moveTime(later);
  fixture.putReceipt(receipt);
  scenario.interruptAndReopen();
  const reads = fixture.inspect().reads;
  assert.equal(reads[0].checkedAt, later.toISOString());

  scenario.moveTime(new Date('2026-11-23T06:30:00Z'));
  assert.deepEqual(scenario.replay(), record);
  assert.deepEqual(fixture.inspect().reads, reads);

  scenario.moveTime(later);
  const fresh = scenario.desk.checkpoint('receipt-recheck-after-rewind').errands[0];
  assert.equal(fresh.status, 'verified');
  assert.deepEqual(fresh.receiptProof, receipt);
});

test('a saved native result is replayed only for the same active grant and agreed proof', async t => {
  for (const change of ['same terms', 'proof edited', 'grant withdrawn', 'grant renewed', 'grant expired']) {
    await t.test(change, t => {
      const scenario = interruptedDesk(t);
      const { fixture, record } = scenario;
      fixture.putReceipt(closure);
      scenario.interruptAndReopen();
      const nativeRead = fixture.inspect().reads;
      const reopened = scenario.desk;
      if (change === 'proof edited') {
        reopened.setup(record.id, { ...practicePlan, status: 'cancelled', capability: 'receipt', revision: record.revision });
      } else if (change === 'grant withdrawn' || change === 'grant renewed') {
        const withdrawn = reopened.householdAccess(record.id, {
          revision: record.revision, operation: 'receipt', choice: 'withdrawn'
        });
        if (change === 'grant renewed') {
          reopened.householdAccess(record.id, { revision: withdrawn.revision, operation: 'receipt', choice: 'allowed' });
        }
      } else if (change === 'grant expired') {
        scenario.moveTime(new Date(record.grants.receipt.expiresAt));
      }
      fixture.putReceipt({ ...closure, status: 'acknowledged' });

      const replay = scenario.replay();
      if (change === 'same terms') {
        assert.equal(replay.status, 'verified');
        assert.deepEqual(replay.receiptProof, closure);
        assert.equal(replay.receiptCheck.checkedAt, nativeRead[0].checkedAt);
      } else {
        assert.equal(replay.status, 'open');
        assert.equal(replay.receiptProof, null);
        assert.equal(replay.receiptCheck ?? null, null);
      }
      assert.deepEqual(fixture.inspect().reads, nativeRead);
    });
  }
});
