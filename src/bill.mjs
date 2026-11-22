import { createHash } from 'node:crypto';
import { activeGrant, sameInvoice } from './household.mjs';

function sameSubject(left, right) {
  return left && right && left.invoiceId === right.invoiceId && left.payee === right.payee && left.currency === right.currency;
}

function invoiceGrant(record, terms, now) {
  const grant = record?.grants?.invoice;
  return grant?.operation === 'invoice' && activeGrant(grant, now) && sameSubject(grant.scope, terms) ? grant : null;
}

function paymentGrant(record, terms, now) {
  const grant = record?.grants?.payment;
  const scope = grant?.scope;
  return grant?.operation === 'payment' && activeGrant(grant, now) && sameSubject(record.bill, terms) &&
    scope?.payee === terms.payee && scope?.currency === terms.currency ? grant : null;
}

function hasExactApproval(record, terms, grant, now) {
  const approval = record.approval;
  return activeGrant(approval, now) && approval.grantRevision === grant.revision && sameInvoice(approval, terms);
}

function allowsAmount(record, terms, grant, now) {
  const { capMinor } = grant.scope;
  return Number.isSafeInteger(capMinor) && capMinor >= 0 &&
    (terms.amountMinor <= capMinor || hasExactApproval(record, terms, grant, now));
}

function allowsSpend({ amountMinor }, { maxCount, budgetMinor }, { spentMinor, count }) {
  return Number.isSafeInteger(maxCount) && count < maxCount &&
    (budgetMinor === undefined || (Number.isSafeInteger(budgetMinor) && spentMinor + amountMinor <= budgetMinor));
}

function paymentIntent(id, { invoiceId, revision, payee, amountMinor, currency }) {
  const identity = JSON.stringify([id, invoiceId, revision, payee, amountMinor, currency]);
  const key = `pay-${createHash('sha256').update(identity).digest('hex')}`;
  return { key, invoiceId, revision, payee, amountMinor, currency };
}

function isNativePayment(payment, intent) {
  return payment?.status === 'accepted' && payment.key === intent.key && sameInvoice(payment, intent) &&
    typeof payment.paymentRef === 'string' && payment.paymentRef.length > 0 && Number.isFinite(Date.parse(payment.acceptedAt));
}

function readUnderGrant(record, terms, journal, now, read) {
  const original = invoiceGrant(record, terms, now);
  if (!original) return null;
  return journal.dispatch(record.id, (current, currentTime) => {
    const fresh = invoiceGrant(current, terms, currentTime ?? now);
    return fresh && fresh.revision === original.revision && current.status !== 'stopped' ? { value: read() } : null;
  });
}

function presentPayment(record, payment, fixture, journal, now) {
  const matching = readUnderGrant(record, payment, journal, now, () => fixture.readSettlement(payment.paymentRef))?.value;
  const settlement = matching?.status === 'settled' && matching.paymentRef === payment.paymentRef &&
    sameInvoice(matching, payment) && Date.parse(matching.settledAt) >= Date.parse(payment.acceptedAt) ? matching : null;
  const approval = record.approval?.status === 'allowed' && sameInvoice(record.approval, payment)
    ? { ...record.approval, status: 'consumed' }
    : record.approval;
  return { ...record, approval, payment, settlement, status: settlement ? 'verified' : 'accepted',
    issue: settlement ? null : 'payment-pending' };
}

function openWith(record, issue) {
  return { ...record, status: 'open', issue };
}

function knownFailure(error) {
  return error?.code === 'not-authorized' || error?.code === 'invoice-changed' || error?.code === 'invalid-payment';
}

export function runBill(record, fixture, journal, clockNow) {
  const now = new Date(clockNow);
  if (record.status === 'verified' || record.status === 'stopped') return record;
  if (record.payment) return presentPayment(record, record.payment, fixture, journal, now);

  const original = journal.latest(record.id, 'pay');
  if (original && original.status !== 'blocked') {
    const readback = readUnderGrant(record, original.payload, journal, now, () => fixture.paymentByKey(original.key));
    if (!readback) return openWith(record, 'payment-unknown');
    const payment = readback.value;
    if (payment) {
      if (!isNativePayment(payment, original.payload)) return openWith(record, 'payment-unknown');
      journal.mark(original.key, 'committed');
      return presentPayment(record, payment, fixture, journal, now);
    }
    if (original.status === 'committed') return openWith(record, 'payment-unknown');
    journal.mark(original.key, 'blocked');
  }

  const readGrant = invoiceGrant(record, record.bill, now);
  const result = readUnderGrant(record, record.bill, journal, now, () => fixture.readInvoice(record.bill.invoiceId));
  if (!result) return openWith(record, 'bill-permission');
  const invoice = result.value;
  if (!invoice) return openWith(record, 'bill-review');
  const spendGrant = paymentGrant(record, invoice, now);
  const updated = {
    ...record,
    invoice,
    previousInvoice: record.invoice && !sameInvoice(record.invoice, invoice) ? record.invoice : record.previousInvoice,
    approval: spendGrant && hasExactApproval(record, invoice, spendGrant, now) ? record.approval : null,
    deferred: sameInvoice(record.deferred, invoice) ? record.deferred : null
  };
  if (updated.deferred) return openWith(updated, 'bill-deferred');
  if (!spendGrant) return openWith(updated, 'bill-permission');
  if (!allowsAmount(updated, invoice, spendGrant, now)) return openWith(updated, 'bill-review');

  const payload = paymentIntent(record.id, invoice);
  const prepared = journal.prepare(record.id, 'pay', payload.key, payload);
  if (prepared.status !== 'prepared') return openWith(updated, 'payment-unknown');
  let payment;
  try {
    payment = journal.dispatch(record.id, (current, currentTime) => {
      const time = currentTime ?? now;
      const currentRead = invoiceGrant(current, payload, time);
      const currentSpend = paymentGrant(current, payload, time);
      if (!currentRead || !currentSpend || currentRead.revision !== readGrant.revision ||
          currentSpend.revision !== spendGrant.revision || current.status === 'stopped' || sameInvoice(current.deferred, payload)) return null;

      return fixture.pay(payload, (terms, totals) => sameInvoice(terms, payload) &&
        allowsAmount(current, terms, currentSpend, time) && allowsSpend(terms, currentSpend.scope, totals));
    });
  } catch (error) {
    const blocked = knownFailure(error);
    journal.mark(payload.key, blocked ? 'blocked' : 'unknown');
    return openWith(updated, blocked ? 'bill-review' : 'payment-unknown');
  }

  if (!payment) {
    journal.mark(payload.key, 'blocked');
    return openWith(updated, 'bill-permission');
  }
  if (!isNativePayment(payment, payload)) {
    journal.mark(payload.key, 'unknown');
    return openWith(updated, 'payment-unknown');
  }
  journal.mark(payload.key, 'committed');
  return presentPayment(updated, payment, fixture, journal, now);
}
