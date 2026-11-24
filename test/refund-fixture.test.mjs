import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
  assert.deepEqual(fixture.readMerchant(merchantScope).links, [merchantLink]);
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
