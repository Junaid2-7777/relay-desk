import { activeGrant } from './household.mjs';
import { isReceiptIdentifier, receiptIdentifier } from './receipt-fixture.mjs';

export { ReceiptPlanError } from './receipt-fixture.mjs';

const zonedTimestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

export function normalizeReceiptPlan(input, sources = []) {
  const issuer = receiptIdentifier(input?.issuer, 'an issuer identifier');
  return {
    issuer,
    subject: receiptIdentifier(input?.subject, 'a subject reference'),
    type: receiptIdentifier(input?.type, 'a record type'),
    status: receiptIdentifier(input?.status, 'a record status'),
    available: sources.some(source => source.issuer === issuer)
  };
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !zonedTimestamp.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const date = value.slice(0, 10);
  const midnight = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(+midnight) && midnight.toISOString().slice(0, 10) === date;
}

function sameScope(left, right) {
  return left && right && left.issuer === right.issuer && left.subject === right.subject;
}

function sameProof(left, right) {
  return sameScope(left, right) && left.type === right.type && left.status === right.status;
}

export function matchingReceipt(plan, receipts) {
  if (plan?.available !== true) return null;
  const matches = receipts.filter(receipt => sameProof(plan, receipt) &&
    isReceiptIdentifier(receipt.id) && validTimestamp(receipt.occurredAt));
  return matches.length === 1 ? matches[0] : null;
}

function readGrant(record, plan, now) {
  const grant = record?.grants?.receipt;
  return grant?.operation === 'receipt' && activeGrant(grant, now) && sameScope(grant.scope, plan) ? grant : null;
}

export function runReceipt(record, fixture, journal, clockNow) {
  if (record.status === 'verified' || record.status === 'stopped') return record;
  const now = new Date(clockNow);
  const plan = normalizeReceiptPlan(record.receiptPlan, fixture.sources());
  const updated = { ...record, receiptPlan: plan, status: 'open', receiptProof: null };
  if (!plan.available) return { ...updated, issue: 'evidence-needed' };
  const grant = readGrant(record, plan, now);
  if (!grant) return { ...updated, issue: 'receipt-permission' };

  const receipts = journal.dispatch(record.id, (current, currentTime) => {
    const fresh = readGrant(current, plan, currentTime ?? now);
    return fresh && fresh.revision === grant.revision && sameProof(current.receiptPlan, plan) && current.status !== 'stopped'
      ? fixture.read({ issuer: plan.issuer, subject: plan.subject })
      : null;
  });
  if (!receipts) return { ...updated, issue: 'receipt-permission' };

  const proof = matchingReceipt(plan, receipts);
  const lastEventAt = receipts.map(receipt => receipt.occurredAt).filter(validTimestamp)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  return {
    ...updated,
    status: proof ? 'verified' : 'open',
    issue: proof ? null : 'receipt-pending',
    receiptProof: proof,
    receiptCheck: { checkedAt: now.toISOString(), lastEventAt }
  };
}
