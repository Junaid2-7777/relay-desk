import { mondayBill } from './bill-fixture.mjs';
import { mondayVisit } from './visit-fixture.mjs';

const day = 86400000;

export function activeGrant(grant, now) {
  return grant?.status === 'allowed' && Date.parse(grant.expiresAt) > +now;
}

export function makeGrant(operation, scope, choice, previous, now) {
  return {
    operation,
    status: choice,
    revision: (previous?.revision ?? 0) + 1,
    scope,
    expiresAt: choice === 'allowed' ? new Date(+now + 7 * day).toISOString() : null
  };
}

export function scopes(record) {
  if (record.visit) {
    return { freeBusy: record.visit, slots: record.visit, reserve: record.visit, calendar: record.visit };
  }
  if (record.bill) {
    const { payee, currency } = record.bill;
    return {
      invoice: record.bill,
      payment: { payee, currency, capMinor: record.capMinor, maxCount: 1 }
    };
  }
  return {};
}

export function seedHousehold(now, warm) {
  const { invoiceId, payee, currency } = mondayBill;
  const cases = [
    {
      id: 'demo-visit',
      kind: 'visit',
      goal: 'Book one free broadband service visit',
      note: 'Please book one free broadband visit on Tuesday afternoon and protect my existing appointments.',
      checkDate: '2026-11-24',
      owner: 'Demo broadband provider',
      visit: mondayVisit
    },
    {
      id: 'demo-bill',
      kind: 'bill',
      goal: 'Pay the electricity bill',
      note: 'Handle the electricity bill for City Electric up to ₹900.',
      checkDate: '2026-11-23',
      owner: 'City Electric',
      bill: { invoiceId, payee, currency },
      invoice: { ...mondayBill, revision: 1, amountMinor: 85000 },
      capMinor: 90000
    }
  ];
  return cases.map(record => ({
    ...record,
    revision: 1,
    status: 'open',
    evidence: [],
    issue: null,
    grants: warm
      ? Object.fromEntries(Object.entries(scopes(record)).map(([key, scope]) => [key, makeGrant(key, scope, 'allowed', null, now)]))
      : {}
  }));
}

export function sameInvoice(a, b) {
  return Boolean(a && b && a.invoiceId === b.invoiceId && a.revision === b.revision &&
    a.payee === b.payee && a.amountMinor === b.amountMinor && a.currency === b.currency);
}

function group(record) {
  if (record.status === 'verified') return 2;
  if (record.issue === 'bill-review' || record.issue === 'calendar-conflict') return 0;
  return 1;
}

export function orderBrief(records) {
  return records.sort((left, right) => group(left) - group(right) ||
    (left.checkDate ?? '9999-12-31').localeCompare(right.checkDate ?? '9999-12-31') ||
    left.id.localeCompare(right.id));
}
