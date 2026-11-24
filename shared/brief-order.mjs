import { zonedInstant } from './evidence-time.mjs';

const invoiceScopeFields = ['invoiceId', 'payee', 'currency'];
const invoiceTerms = [...invoiceScopeFields, 'revision', 'amountMinor'];
const visitScopeFields = ['issuer', 'service', 'subject', 'zone', 'windowStart', 'windowEnd'];
const sameFields = (left, right, fields) => fields.every(field => left?.[field] != null && left[field] === right?.[field]);

export function grantActiveAt(grant, now) {
  const instant = typeof now === 'string' ? zonedInstant(now) : now == null ? NaN : +now;
  return grant?.status === 'allowed' && Number.isFinite(instant) && zonedInstant(grant.expiresAt) > instant;
}

function activeOperation(grant, operation, now) {
  return grant?.operation === operation && Number.isSafeInteger(grant.revision) && grant.revision > 0 && grantActiveAt(grant, now);
}

export function billDecision(record, now) {
  const { bill, invoice, approval, capMinor, grants, payment, deferred } = record;
  if (record.status !== 'open' || record.issue !== 'bill-review' || !bill || !invoice || payment ||
      sameFields(deferred, invoice, invoiceTerms)) return null;

  const canDefer = invoice.invoiceId === bill.invoiceId && activeOperation(grants?.invoice, 'invoice', now) &&
    sameFields(grants.invoice.scope, bill, invoiceScopeFields);
  const exception = Number.isSafeInteger(capMinor) && capMinor >= 0 && Number.isSafeInteger(invoice.amountMinor) &&
    invoice.amountMinor > capMinor && sameFields(invoice, bill, invoiceScopeFields);
  const canApprove = canDefer && exception && activeOperation(grants?.payment, 'payment', now) &&
    sameFields(grants.payment.scope, invoice, ['payee', 'currency']) && grants.payment.scope.capMinor === capMinor;
  const approved = canApprove && grantActiveAt(approval, now) && approval.grantRevision === grants.payment.revision &&
    sameFields(approval, invoice, invoiceTerms);
  return { canDefer, canApprove, approved, exception };
}

export function calendarConflictChoice(record) {
  const { conflictChoice, conflict, reservation } = record;
  if (!conflictChoice || !conflict || !reservation) return null;
  const { choice, reservationId, start, end } = conflictChoice;
  return (choice === 'handle' || choice === 'watch') && reservationId === reservation.id &&
    start === conflict.start && end === conflict.end ? choice : null;
}

export function visitConflictDecision(record, now) {
  if (record.status !== 'booked' || record.issue !== 'calendar-conflict' || !record.visit || !record.reservation || !record.conflict) return null;
  const missing = ['slots', 'freeBusy'].filter(operation => {
    const grant = record.grants?.[operation];
    return !activeOperation(grant, operation, now) || !sameFields(grant.scope, record.visit, visitScopeFields) ||
      Object.keys(grant.scope).length !== visitScopeFields.length || Object.keys(record.visit).length !== visitScopeFields.length;
  });
  const { conflict, reservation } = record;
  const start = zonedInstant(conflict.start);
  const end = zonedInstant(conflict.end);
  const bookedStart = zonedInstant(reservation.start);
  const bookedEnd = zonedInstant(reservation.end);
  const confirmed = typeof reservation.id === 'string' && reservation.id.length > 0 &&
    reservation.status === 'confirmed' && bookedStart < bookedEnd;
  const canChoose = confirmed && start < end && start < bookedEnd && end > bookedStart && !missing.length;
  return { canChoose, missing, choice: calendarConflictChoice(record) };
}

export function reviewNeeded(record, now) {
  const bill = billDecision(record, now);
  if (bill) return bill.canApprove && !bill.approved;
  const visit = visitConflictDecision(record, now);
  return Boolean(visit?.canChoose && !visit.choice);
}

function priority(record, now) {
  if (record.status === 'verified') return 2;
  if (record.status === 'stopped') return 3;
  return reviewNeeded(record, now) ? 0 : 1;
}

function compareChecks(left, right, now) {
  return priority(left, now) - priority(right, now) ||
    Number(!left.checkDate) - Number(!right.checkDate) ||
    (left.checkDate ?? '').localeCompare(right.checkDate ?? '');
}

export function orderChecks(records, household, now) {
  return records.sort((left, right) => compareChecks(left, right, now) || (household ? left.id.localeCompare(right.id) : 0));
}
