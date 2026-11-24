import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDesk } from '../src/desk.mjs';
import { mondayRefund, openRefundFixture } from '../src/refund-fixture.mjs';
import { checkRefund, refundGrant } from '../src/refund.mjs';

const { account, reference, merchantIssuer: issuer, thread, currency, amountMinor } = mondayRefund;
const merchantScope = { issuer, thread, reference };
const ledgerScope = { account, reference };
const checkedAt = '2026-11-23T03:30:00.000Z';
const linkedCredit = {
  id: 'credit-demo-explicit-link',
  account,
  amountMinor,
  currency,
  direction: 'incoming',
  status: 'posted',
  returnReference: null,
  postedAt: checkedAt
};
const merchantLink = { issuer, thread, returnReference: reference, creditId: linkedCredit.id };

test('a refund source checks permission at the actual read and retry time', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-refund-expiry-'));
  const now = new Date(checkedAt);
  const access = Object.fromEntries(['merchant', 'credits'].map(source =>
    [source, refundGrant(mondayRefund, source, 'allowed', null, now)]));
  const record = { status: 'open', checks: {}, evidence: [], refundAccess: access };
  const expiry = new Date(access.credits.expiresAt);
  let providerTime = () => expiry;
  const fixture = openRefundFixture({ dataDir, clock: () => providerTime() });
  t.after(() => {
    fixture.close();
    rmSync(dataDir, { force: true, recursive: true });
  });
  fixture.reset();
  fixture.putCredit({ ...linkedCredit, returnReference: reference });
  assert.deepEqual(checkRefund(record, fixture, now), record);
  assert.deepEqual(fixture.inspect().reads, []);

  fixture.setAvailable('merchant', false);
  const beforeExpiry = new Date(+expiry - 1);
  const instants = [beforeExpiry, expiry, expiry];
  providerTime = () => instants.shift();
  const last = checkRefund(record, fixture, now);
  assert.equal(last.status, 'open');
  assert.equal(last.checks.merchant.status, 'unavailable');
  assert.equal(last.checks.merchant.checkedAt, null);
  assert.equal(last.checks.credits, undefined);
  assert.deepEqual(fixture.inspect().reads.map(row => [row.source, row.status]), [['merchant', 'unavailable']]);
});

test('a future link in a merchant response never enters the desk’s ledger request', () => {
  const now = new Date(checkedAt);
  const refundAccess = Object.fromEntries(['merchant', 'credits'].map(source =>
    [source, refundGrant(mondayRefund, source, 'allowed', null, now)]));
  const requests = [];
  const fixture = {
    subject: mondayRefund,
    readForCheck(source, scope) {
      requests.push({ source, scope });
      const links = [{ ...merchantLink, issuedAt: '2026-11-24T03:30:00.000Z' }];
      return { status: 'checked', checkedAt, records: source === 'merchant' ? { links, events: [] } : [] };
    }
  };
  assert.equal(checkRefund({ status: 'open', checks: {}, evidence: [], refundAccess }, fixture, now).status, 'open');
  assert.deepEqual(requests.at(-1), { source: 'credits', scope: { ...ledgerScope, linkedCreditIds: [] } });
});

test('the provider bounds credits by account and independently authorized references', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-refund-fixture-'));
  const fixture = openRefundFixture({ dataDir, clock: () => new Date(checkedAt) });
  t.after(() => {
    fixture.close();
    rmSync(dataDir, { force: true, recursive: true });
  });
  fixture.reset();
  const unrelatedCredit = fixture.inspect().credits[0];
  assert.equal(unrelatedCredit.amountMinor, amountMinor);
  assert.notEqual(unrelatedCredit.returnReference, reference);
  assert.deepEqual(fixture.readCredits({ ...ledgerScope, linkedCreditIds: [unrelatedCredit.id] }), []);

  fixture.putCredit(linkedCredit);
  fixture.putLink({ ...merchantLink, issuer: 'merchant-demo-other' });
  fixture.putLink({ ...merchantLink, thread: 'thread-demo-other' });
  assert.deepEqual(fixture.readMerchant(merchantScope).links, []);
  assert.deepEqual(fixture.readCredits({ ...ledgerScope, linkedCreditIds: [linkedCredit.id] }), []);

  fixture.putLink(merchantLink);
  assert.deepEqual(fixture.readMerchant({ ...merchantScope, reference: 'return-demo-other' }), { events: [], links: [] });
  assert.deepEqual(fixture.readMerchant(merchantScope).links, [{ ...merchantLink, issuedAt: checkedAt }]);
  assert.deepEqual(fixture.readCredits({ ...ledgerScope, account: 'ledger-demo-other', linkedCreditIds: [linkedCredit.id] }), []);
  assert.deepEqual(fixture.readCredits({ ...ledgerScope, linkedCreditIds: [linkedCredit.id] }), [linkedCredit]);

  fixture.putLink({ ...merchantLink, returnReference: 'return-demo-other' });
  assert.deepEqual(fixture.readMerchant(merchantScope).links, []);
  assert.deepEqual(fixture.readCredits({ ...ledgerScope, linkedCreditIds: [linkedCredit.id] }), []);
  const reads = fixture.inspect().reads;
  assert.deepEqual(reads[0], {
    source: 'credits',
    scope: { ...ledgerScope, linkedCreditIds: [] },
    checkedAt
  });
  assert.ok(!JSON.stringify(reads).includes(unrelatedCredit.id));

  fixture.reset();
  assert.deepEqual(fixture.inspect().credits, [unrelatedCredit]);
  assert.deepEqual(fixture.inspect().reads, []);
  assert.deepEqual(fixture.inspect().links, []);
  assert.equal(fixture.inspect().events[0].type, 'promise');
});

test('legacy merchant links remain usable and new contradictory links apply from their issue date', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-refund-link-migration-'));
  const legacy = new DatabaseSync(join(dataDir, 'refund-fixture.sqlite'));
  legacy.exec(`CREATE TABLE return_links (
    issuer TEXT NOT NULL, thread TEXT NOT NULL, returnReference TEXT NOT NULL, creditId TEXT NOT NULL,
    PRIMARY KEY (issuer, thread, returnReference, creditId)
  ) STRICT`);
  legacy.prepare('INSERT INTO return_links VALUES (?, ?, ?, ?)').run(issuer, thread, reference, linkedCredit.id);
  legacy.close();
  let time = new Date(checkedAt);
  const fixture = openRefundFixture({ dataDir, clock: () => time });
  t.after(() => {
    fixture.close();
    rmSync(dataDir, { force: true, recursive: true });
  });
  fixture.putCredit(linkedCredit);
  const later = '2026-11-24T09:00:00+05:30';
  const contradictory = { ...merchantLink, returnReference: 'another-practice-return', issuedAt: later };
  fixture.putLink(contradictory);
  assert.throws(() => fixture.putLink({ ...contradictory, issuedAt: '2026-02-30T09:00:00Z' }), /valid issue time/);
  assert.deepEqual(fixture.readMerchant(merchantScope).links, [{ ...merchantLink, issuedAt: null }]);
  const ledger = { ...ledgerScope, linkedCreditIds: [linkedCredit.id] };
  assert.deepEqual(fixture.readCredits(ledger), [linkedCredit]);
  time = new Date(later);
  assert.deepEqual(fixture.readMerchant(merchantScope).links, []);
  assert.deepEqual(fixture.readCredits(ledger), []);
  assert.deepEqual(fixture.inspect().reads.at(-1).scope, { ...ledgerScope, linkedCreditIds: [] });
});

function interruptedRefund(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-interrupted-refund-'));
  let time = new Date(checkedAt);
  const clock = () => time;
  const fixture = openRefundFixture({ dataDir, clock });
  fixture.reset();
  const household = { receipt: { fixture: { sources: () => [] } } };
  const open = () => openDesk({ dataDir, clock, household, refundFixture: fixture });
  let desk = open();
  t.after(() => {
    desk?.close();
    fixture.close();
    rmSync(dataDir, { force: true, recursive: true });
  });
  const record = desk.resetRefund(true);
  const checkpoint = 'interrupted-refund-check';
  return {
    fixture, record,
    get desk() { return desk; },
    moveTime(value) { time = new Date(value); },
    interruptAndReopen() {
      const injector = new DatabaseSync(join(dataDir, 'desk.sqlite'));
      try {
        injector.exec(`CREATE TRIGGER interrupt_refund_check BEFORE UPDATE ON errands
          BEGIN SELECT RAISE(ABORT, 'Simulated interruption after native refund read'); END`);
        assert.throws(() => desk.checkRefund(record.id, checkpoint), /Simulated interruption/);
        desk.close();
        desk = null;
        injector.exec('DROP TRIGGER interrupt_refund_check');
        desk = open();
      } finally {
        injector.close();
      }
    },
    replay: () => desk.checkRefund(record.id, checkpoint)
  };
}

test('a named refund checkpoint shares one retry across both feeds even after an interrupted desk commit', t => {
  const scenario = interruptedRefund(t);
  const { fixture, record } = scenario;
  fixture.setAvailable('merchant', false);
  fixture.setAvailable('credits', false);
  scenario.interruptAndReopen();
  const failed = fixture.inspect().reads;
  assert.deepEqual(failed.map(({ source, status }) => [source, status]), [
    ['merchant', 'unavailable'], ['merchant', 'unavailable'], ['credits', 'unavailable']
  ]);

  fixture.setAvailable('merchant', true);
  fixture.setAvailable('credits', true);
  fixture.putCredit({ ...linkedCredit, returnReference: reference });
  const replayed = scenario.replay();
  assert.equal(replayed.status, 'open');
  assert.deepEqual(replayed.evidence, []);
  for (const source of ['merchant', 'credits']) {
    assert.equal(replayed.checks[source].status, 'unavailable');
    assert.equal(replayed.checks[source].checkedAt, null);
  }
  assert.deepEqual(fixture.inspect().reads, failed);
  assert.equal(scenario.desk.checkRefund(record.id, 'new-refund-check').status, 'verified');
  assert.equal(fixture.inspect().reads.length, failed.length + 2);
});

test('rewinding before an interrupted checkpoint cannot replay a future link snapshot', t => {
  const scenario = interruptedRefund(t);
  const { fixture, record } = scenario;
  const tuesday = '2026-11-24T03:30:00.000Z';
  fixture.putCredit(linkedCredit);
  scenario.moveTime(tuesday);
  fixture.putLink(merchantLink);
  scenario.interruptAndReopen();
  const originalReads = fixture.inspect().reads;
  assert.deepEqual(originalReads.at(-1).scope, { ...ledgerScope, linkedCreditIds: [linkedCredit.id] });

  scenario.moveTime(checkedAt);
  assert.deepEqual(scenario.replay(), record);
  assert.deepEqual(fixture.inspect().reads, originalReads);
  scenario.moveTime(tuesday);
  assert.equal(scenario.replay().status, 'verified');
  assert.deepEqual(fixture.inspect().reads, originalReads);
});

test('an interrupted refund check reuses exact linked settlement proof only with its original grants', async t => {
  for (const change of ['same grants', 'merchant withdrawn', 'merchant renewed', 'merchant expired']) {
    await t.test(change, t => {
      const scenario = interruptedRefund(t);
      const { fixture, record } = scenario;
      fixture.putCredit(linkedCredit);
      fixture.putLink(merchantLink);
      if (change === 'merchant expired') {
        scenario.moveTime('2026-11-24T03:30:00.000Z');
        scenario.desk.refundAccess(record.id, { source: 'credits', choice: 'allowed', revision: record.revision });
      }
      scenario.interruptAndReopen();
      const originalReads = fixture.inspect().reads;
      const saved = scenario.desk.brief().errands[0];
      if (change === 'merchant withdrawn' || change === 'merchant renewed') {
        const withdrawn = scenario.desk.refundAccess(record.id, { source: 'merchant', choice: 'withdrawn', revision: saved.revision });
        if (change === 'merchant renewed') {
          scenario.desk.refundAccess(record.id, { source: 'merchant', choice: 'allowed', revision: withdrawn.revision });
        }
      } else if (change === 'merchant expired') {
        scenario.moveTime(record.refundAccess.merchant.expiresAt);
      } else {
        scenario.moveTime('2026-11-24T03:30:00.000Z');
        fixture.putCredit({ ...linkedCredit, status: 'pending', postedAt: null });
      }

      const replayed = scenario.replay();
      assert.deepEqual(fixture.inspect().reads, originalReads);
      if (change === 'same grants') {
        assert.equal(replayed.status, 'verified');
        assert.equal(replayed.evidence[0].reference, linkedCredit.id);
        assert.equal(replayed.evidence[0].postedAt, linkedCredit.postedAt);
        assert.equal(replayed.checks.merchant.checkedAt, originalReads[0].checkedAt);
        assert.equal(replayed.checks.credits.checkedAt, originalReads[1].checkedAt);
      } else {
        assert.equal(replayed.status, 'open');
        assert.deepEqual(replayed.evidence, []);
        assert.deepEqual(replayed.checks, {});
        if (change !== 'merchant renewed') {
          const recovered = scenario.desk.checkRefund(record.id, 'ledger-only-new-check');
          assert.equal(recovered.status, 'open');
          assert.deepEqual(fixture.inspect().reads.at(-1).scope, { ...ledgerScope, linkedCreditIds: [] });
        }
      }
    });
  }
});
