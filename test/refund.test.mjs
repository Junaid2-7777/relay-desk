import assert from 'node:assert/strict';
import test from 'node:test';
import {matchRefundCredit} from '../src/refund.mjs';

const refund = {
  reference: 'return-1', account: 'ledger-1', amountMinor: 124_900, currency: 'INR',
  merchantIssuer: 'shop-1', thread: 'thread-1',
};
const credit = {
  id: 'credit-1', returnReference: refund.reference, account: refund.account,
  amountMinor: refund.amountMinor, currency: refund.currency, direction: 'incoming',
  status: 'posted', postedAt: '2026-11-27T09:30:00+05:30',
};
const link = {
  issuer: refund.merchantIssuer, thread: refund.thread, returnReference: refund.reference, creditId: credit.id,
};

test('verifies only the exact posted incoming credit', () => {
  const cases = [
    {id: 'credit-pending', status: 'pending'},
    {id: 'credit-other-return', returnReference: 'another-return'},
    {id: 'credit-other-account', account: 'another-ledger'},
    {id: 'credit-other-currency', currency: 'USD'},
    {id: 'credit-outgoing', direction: 'outgoing'},
    {id: 'credit-partial', amountMinor: 24_900},
    {id: 'credit-undated', postedAt: null},
    {id: 'credit-impossible-date', postedAt: '2026-02-30T04:00:00Z'},
  ].map(overrides => ({...credit, ...overrides}));
  assert.equal(matchRefundCredit(refund, {credits: cases}), null);
  assert.equal(matchRefundCredit(refund, {credits: [...cases, credit]}), credit);
});

test('leaves equally strong direct matches unverified', () => {
  assert.equal(matchRefundCredit(refund, {credits: [credit, {...credit, id: 'credit-2'}]}), null);
});

test('requires the scoped merchant to link a credit without a return reference', () => {
  const unlinked = {...credit, returnReference: null};
  const credits = [unlinked, {...unlinked, id: 'credit-2'}];
  assert.equal(matchRefundCredit(refund, {credits}), null);
  assert.equal(matchRefundCredit(refund, {credits, links: [{...link, issuer: 'another-shop'}]}), null);
  assert.equal(matchRefundCredit(refund, {credits, links: [{...link, thread: 'another-thread'}]}), null);
  assert.equal(matchRefundCredit(refund, {credits, links: [link]}), unlinked);
  assert.equal(matchRefundCredit(refund, {credits, links: [link, {...link, creditId: 'credit-2'}]}), null);
  assert.equal(matchRefundCredit(refund, {credits, links: [link, {...link, returnReference: 'another-return'}]}), null);
});

test('does not override a conflicting native return reference with a merchant link', () => {
  const credits = [{...credit, returnReference: 'another-return'}];
  assert.equal(matchRefundCredit(refund, {credits, links: [link]}), null);
});
