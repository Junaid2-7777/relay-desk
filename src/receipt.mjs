import { createHash } from 'node:crypto';
import { evidenceInstant, latestEvidence } from '../shared/evidence-time.mjs';
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

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The caller holds the errand lock from the grant check through the saved result.
export function checkReceipt(record, fixture, readClock, checkpointId) {
  if (record.status === 'verified' || record.status === 'stopped') return record;
  const sources = fixture.sources();
  const plan = normalizeReceiptPlan(record.receiptPlan, sources);
  const owner = sources.find(source => source.issuer === plan.issuer)?.label ?? record.owner ?? plan.issuer;
  const updated = { ...record, owner, receiptPlan: plan, status: 'open', receiptProof: null };
  if (!plan.available) return { ...updated, issue: 'evidence-needed' };
  const grant = readGrant(record, plan, readClock());
  if (!grant) return { ...updated, issue: 'receipt-permission' };
  const replay = checkpointId === undefined ? null : {
    key: fingerprint([record.id, checkpointId]),
    binding: fingerprint([record.revision, plan.issuer, plan.subject, plan.type, plan.status, grant.revision, grant.expiresAt])
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const read = fixture.readForCheck({ issuer: plan.issuer, subject: plan.subject }, {
      authorize: () => Boolean(readGrant(record, plan, readClock())),
      ...(replay ? { replay: { ...replay, attempt } } : {})
    });
    if (read.status === 'unavailable') continue;
    if (read.status === 'denied') return { ...updated, issue: 'receipt-permission' };
    if (read.status === 'superseded') return record;
    const proof = matchingReceipt(plan, read.receipts);
    const previous = { occurredAt: record.receiptCheck?.lastEventAt };
    const lastEventAt = latestEvidence(read.receipts, 'occurredAt', previous)?.occurredAt ?? null;
    return {
      ...updated,
      status: proof ? 'verified' : 'open',
      issue: proof ? null : 'receipt-pending',
      receiptProof: proof,
      receiptCheck: { checkedAt: read.checkedAt, lastEventAt }
    };
  }
  return { ...updated, issue: 'receipt-unavailable' };
}

export function runReceipt(record, fixture, journal, clockNow) {
  if (['verified', 'stopped'].includes(record.status)) return record;
  const plan = normalizeReceiptPlan(record.receiptPlan, fixture.sources());
  if (!plan.available) return { ...record, receiptPlan: plan, status: 'open', receiptProof: null, issue: 'evidence-needed' };
  return journal.dispatch(record.id, (current, now, readClock) => {
    if (record.grants?.receipt?.revision !== current.grants?.receipt?.revision ||
        !sameReceiptProof(record.receiptPlan, current.receiptPlan)) {
      return { ...record, issue: 'receipt-permission' };
    }
    return checkReceipt(current, fixture, readClock ?? (() => new Date(now ?? clockNow)));
  });
}
