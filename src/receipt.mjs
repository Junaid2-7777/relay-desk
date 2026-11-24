import { evidenceInstant, latestEvidence } from './evidence-time.mjs';
import { activeGrant } from './household.mjs';
import { isReceiptIdentifier, receiptIdentifier } from './receipt-fixture.mjs';

export { ReceiptPlanError } from './receipt-fixture.mjs';

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

export function sameReceiptScope(left, right) {
  return left && right && left.issuer === right.issuer && left.subject === right.subject;
}

export function sameReceiptProof(left, right) {
  return sameReceiptScope(left, right) && left.type === right.type && left.status === right.status;
}

export function matchingReceipt(plan, receipts) {
  if (plan?.available !== true) return null;
  const matches = receipts.filter(receipt => sameReceiptProof(plan, receipt) &&
    isReceiptIdentifier(receipt.id) && Number.isFinite(evidenceInstant(receipt.occurredAt)));
  return matches.length === 1 ? matches[0] : null;
}

function readGrant(record, plan, now) {
  const grant = record?.grants?.receipt;
  return grant?.operation === 'receipt' && activeGrant(grant, now) && sameReceiptScope(grant.scope, plan) ? grant : null;
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
    return fresh && fresh.revision === grant.revision && sameReceiptProof(current.receiptPlan, plan) && current.status !== 'stopped'
      ? fixture.read({ issuer: plan.issuer, subject: plan.subject })
      : null;
  });
  if (!receipts) return { ...updated, issue: 'receipt-permission' };

  const proof = matchingReceipt(plan, receipts);
  const lastEventAt = latestEvidence(receipts, 'occurredAt')?.occurredAt ?? null;
  return {
    ...updated,
    status: proof ? 'verified' : 'open',
    issue: proof ? null : 'receipt-pending',
    receiptProof: proof,
    receiptCheck: { checkedAt: now.toISOString(), lastEventAt }
  };
}
