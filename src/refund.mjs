const postedTimestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

function hasPostedTimestamp(value) {
  if (typeof value !== 'string' || !postedTimestamp.test(value)) return false;
  const date = value.slice(0, 10);
  const midnight = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().slice(0, 10) === date;
}

function isPostedCredit(credit, refund) {
  return typeof credit.id === 'string' && credit.id.length > 0 &&
    credit.account === refund.account && credit.amountMinor === refund.amountMinor &&
    credit.currency === refund.currency && credit.direction === 'incoming' &&
    credit.status === 'posted' && hasPostedTimestamp(credit.postedAt);
}

function isLinked(credit, refund, links) {
  if (credit.returnReference !== null || !refund.merchantIssuer || !refund.thread) return false;
  const references = new Set(links
    .filter(link => link.issuer === refund.merchantIssuer && link.thread === refund.thread && link.creditId === credit.id)
    .map(link => link.returnReference));
  return references.size === 1 && references.has(refund.reference);
}

export function matchRefundCredit(refund, {credits = [], links = []} = {}) {
  if (!refund?.reference || !refund.account || !/^[A-Z]{3}$/u.test(refund.currency) ||
      !Number.isSafeInteger(refund.amountMinor) || refund.amountMinor <= 0) return null;

  const matches = credits.filter(credit => isPostedCredit(credit, refund) &&
    (credit.returnReference === refund.reference || isLinked(credit, refund, links)));
  return matches.length === 1 ? matches[0] : null;
}

const grantLifetime = 7 * 24 * 60 * 60 * 1000;
export const refundSources = ['merchant', 'credits'];

export function refundScope(subject, source) {
  return source === 'merchant'
    ? { issuer: subject.merchantIssuer, thread: subject.thread, reference: subject.reference }
    : { account: subject.account, reference: subject.reference };
}

export function refundGrant(subject, source, choice, previous, now) {
  return {
    source,
    operation: 'read',
    status: choice,
    revision: (previous?.revision ?? 0) + 1,
    scope: refundScope(subject, source),
    expiresAt: choice === 'allowed' ? new Date(+now + grantLifetime).toISOString() : null
  };
}

export function refundAccess(grant, now) {
  if (grant?.status === 'allowed' && !(Date.parse(grant.expiresAt) > +now)) return 'expired';
  return grant?.status ?? 'unasked';
}

export function checkRefund(record, fixture, now) {
  const subject = fixture.subject;
  const allowed = source => {
    const grant = record.refundAccess[source];
    return grant?.operation === 'read' && refundAccess(grant, now) === 'allowed' &&
      Object.entries(refundScope(subject, source)).every(([field, value]) => grant.scope[field] === value);
  };
  const checkedAt = now.toISOString();
  const checks = { ...record.checks };
  let { merchantEvent = null } = record;
  let links = [];
  let credit = null;
  if (allowed('merchant')) {
    const merchant = fixture.readMerchant(refundScope(subject, 'merchant'));
    links = merchant.links;
    merchantEvent = merchant.events.at(-1) ?? merchantEvent;
    checks.merchant = { checkedAt, lastEventAt: merchantEvent?.occurredAt ?? null };
  }
  if (allowed('credits')) {
    const credits = fixture.readCredits({
      ...refundScope(subject, 'credits'),
      linkedCreditIds: links.map(link => link.creditId)
    });
    credit = matchRefundCredit(subject, { credits, links });
    const lastEventAt = credits.reduce((latest, row) =>
      Date.parse(row.postedAt) > Date.parse(latest ?? '1970-01-01') ? row.postedAt : latest,
    checks.credits?.lastEventAt ?? null);
    checks.credits = { checkedAt, lastEventAt };
  }
  if (!allowed('merchant') && !allowed('credits')) return record;
  return {
    ...record,
    merchantEvent,
    checks,
    status: credit ? 'verified' : record.status,
    evidence: credit
      ? [{ source: 'credits', reference: credit.id, amountMinor: credit.amountMinor, currency: credit.currency, postedAt: credit.postedAt }]
      : record.evidence
  };
}
