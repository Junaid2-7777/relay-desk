import assert from 'node:assert/strict';
import test from 'node:test';
import { matchedReadbacks } from '../scripts/compare-planners.mjs';
import { reviewHeldOutAudit } from '../scripts/held-out-rubric.mjs';

const checkedAt = '2026-11-23T03:30:00.000Z';
const reference = 'practice-return';
const amountMinor = 124900;
const currency = 'INR';
const account = 'practice-account';
const shopScope = { issuer: 'practice-shop', thread: 'practice-thread', reference };
const ledgerScope = { account, reference };
const credit = { id: 'practice-credit', amountMinor, currency, account, status: 'posted',
  direction: 'incoming', postedAt: checkedAt, returnReference: reference };
const record = {
  status: 'verified', refund: { reference, amountMinor, currency },
  refundAccess: {
    merchant: { operation: 'read', status: 'allowed', scope: shopScope },
    credits: { operation: 'read', status: 'allowed', scope: ledgerScope }
  },
  checks: { merchant: { status: 'checked', checkedAt }, credits: { status: 'checked', checkedAt } },
  evidence: [{ source: 'credits', reference: credit.id, amountMinor, currency, postedAt: checkedAt }]
};
const merchant = { source: 'merchant', checkedAt, scope: shopScope };
const ledger = { source: 'credits', checkedAt, scope: { ...ledgerScope, linkedCreditIds: [] } };

test('a failed or stale ledger lookup cannot support a verified refund in the evaluator', () => {
  const proof = (reads, errand = record) => matchedReadbacks(errand, { refund: { credits: [credit], links: [], reads } }).credit;
  assert.equal(proof([ledger]), true);
  assert.equal(proof([{ ...ledger, status: 'unavailable' }]), false);
  assert.equal(proof([ledger, { ...ledger, status: 'unavailable' }]), false);
  assert.equal(proof([{ ...ledger, checkedAt: '2026-11-22T03:30:00.000Z' }]), false);
  assert.equal(proof([ledger], { ...record, checks: { credits: { status: 'unavailable', checkedAt } } }), false);
});

test('a credit without a return reference needs both the merchant lookup and its ID in the ledger read', () => {
  const link = { issuer: shopScope.issuer, thread: shopScope.thread, returnReference: reference, creditId: credit.id };
  const linked = { ...ledger, scope: { ...ledgerScope, linkedCreditIds: [credit.id] } };
  const proof = (reads, errand = record) => matchedReadbacks(errand, { refund: {
    credits: [{ ...credit, returnReference: null }], links: [link], reads
  } }).credit;
  assert.equal(proof([merchant, linked]), true);
  assert.equal(proof([merchant, ledger]), false);
  assert.equal(proof([linked]), false);
  assert.equal(proof([{ ...merchant, status: 'unavailable' }, linked]), false);
  assert.equal(proof([{ ...merchant, scope: { ...shopScope, thread: 'another-thread' } }, linked]), false);
  const revoked = { ...record, refundAccess: { ...record.refundAccess,
    merchant: { ...record.refundAccess.merchant, status: 'withdrawn' } } };
  assert.equal(proof([merchant, linked], revoked), true);
});

test('the evaluator preserves outages in its refund read audit', () => {
  const failed = { ...ledger, status: 'unavailable' };
  const native = {
    refund: { reads: [merchant, failed] }, bill: { reads: [], attempts: [], payments: [] },
    visit: { reads: [], attempts: [], reservations: [], calendar: [] }, outbox: { attempts: [], messages: [] }, receipt: { reads: [] }
  };
  assert.deepEqual(reviewHeldOutAudit(native, [], 'demo-refund').refundReads, [
    { source: 'merchant', scope: shopScope }, { source: 'credits', scope: failed.scope, status: 'unavailable' }
  ]);
});
