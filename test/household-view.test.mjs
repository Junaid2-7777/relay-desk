import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHousehold } from '../public/household.mjs';
import { seedHousehold } from '../src/household.mjs';

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
  } finally {
    delete globalThis.document;
  }
});
