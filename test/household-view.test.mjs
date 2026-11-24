import assert from 'node:assert/strict';
import test from 'node:test';
import { money, renderHousehold, statusLabel } from '../public/household.mjs';
import { seedHousehold } from '../src/household.mjs';

test('bill amounts use the minor units of the invoiced currency', () => {
  assert.equal(money(118000), '₹1,180');
  assert.match(money(1250, 'JPY'), /1,250$/u);
  assert.match(money(1250, 'BHD'), /1\.25$/u);
  assert.match(money(1251, 'BHD'), /1\.251$/u);
  assert.equal(money(1250, 'unrecognized'), '1250 minor units (currency unclear)');
});

test('the bill card identifies last seen amounts and the invoice selected for review', () => {
  const node = () => ({
    children: [],
    append(...children) { this.children.push(...children); },
    addEventListener() {},
    classList: { add() {} }
  });
  globalThis.document = { createElement: node };
  try {
    const now = new Date('2026-11-23T03:30:00Z');
    const contents = element => [element.textContent, ...element.children.flatMap(contents)].filter(Boolean);
    const view = (record, time = now) => {
      const panel = node();
      const facts = node('dl');
      renderHousehold(panel, facts, record, () => {}, time);
      return { facts: contents(facts), panel: contents(panel), label: statusLabel(record, time) };
    };
    const cold = seedHousehold(now, false).find(record => record.kind === 'bill');
    assert.deepEqual(view({ ...cold, issue: 'bill-permission' }).facts.slice(2, 6), [
      'Last seen invoice', '₹850', 'Standing limit', '₹900'
    ]);

    const warm = seedHousehold(now, true).find(record => record.kind === 'bill');
    const revised = { ...warm.invoice, revision: 2, amountMinor: 118000 };
    const review = { ...warm, invoice: revised, previousInvoice: warm.invoice, issue: 'bill-review' };
    assert.deepEqual(view(review).facts, [
      'Previous invoice', '₹850', 'Invoice under review', '₹1,180', 'Standing limit', '₹900'
    ]);
    assert.equal(view(review).label, 'Needs your review');
    assert.ok(view(review).panel.includes('Pay ₹1,180 once'));

    const withWithdrawal = operation => view({ ...review, grants: {
      ...review.grants, [operation]: { ...review.grants[operation], status: 'withdrawn' }
    } });
    assert.equal(withWithdrawal('payment').label, 'Payment on hold');
    assert.ok(withWithdrawal('payment').panel.includes('Leave unpaid'));
    assert.ok(!withWithdrawal('payment').panel.includes('Pay ₹1,180 once'));
    assert.equal(withWithdrawal('invoice').label, 'Invoice check paused');
    assert.ok(!withWithdrawal('invoice').panel.includes('Leave unpaid'));
    const approval = { ...revised, status: 'allowed', grantRevision: review.grants.payment.revision, expiresAt: '2026-11-23T03:45:00Z' };
    const approved = { ...review, approval };
    assert.equal(view(approved).label, 'Payment approved');
    assert.ok(!view(approved).panel.includes('Pay ₹1,180 once'));
    assert.equal(view(approved, approval.expiresAt).label, 'Needs your review');

    const panel = node();
    renderHousehold(panel, node(), { ...warm, issue: 'bill-permission', invoice: {
      ...revised, payee: 'changed-identifier', currency: 'JPY'
    } }, () => {}, now);
    assert.ok(panel.children.some(child =>
      child.textContent?.includes('JPY to changed-identifier') && child.textContent.includes('INR to city-electric')));
  } finally {
    delete globalThis.document;
  }
});
