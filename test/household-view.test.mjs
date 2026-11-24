import assert from 'node:assert/strict';
import test from 'node:test';
import { money, renderHousehold } from '../public/household.mjs';
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
    const amounts = record => {
      const facts = node('dl');
      renderHousehold(node('fieldset'), facts, record, () => {}, now);
      return facts.children.map(child => child.textContent);
    };
    const cold = seedHousehold(now, false).find(record => record.kind === 'bill');
    assert.deepEqual(amounts({ ...cold, issue: 'bill-permission' }).slice(2, 6), [
      'Last seen invoice', '₹850', 'Standing limit', '₹900'
    ]);

    const warm = seedHousehold(now, true).find(record => record.kind === 'bill');
    const revised = { ...warm.invoice, revision: 2, amountMinor: 118000 };
    assert.deepEqual(amounts({ ...warm, invoice: revised, previousInvoice: warm.invoice, issue: 'bill-review' }), [
      'Previous invoice', '₹850', 'Invoice under review', '₹1,180', 'Standing limit', '₹900'
    ]);

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
