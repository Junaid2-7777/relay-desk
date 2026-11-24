import { evidenceInstant, latestEvidence } from '../shared/evidence-time.mjs';
import { RefundFeedUnavailable } from './refund-fixture.mjs';

function isPostedCredit(credit, refund) {
  return typeof credit.id === 'string' && credit.id.length > 0 &&
    credit.account === refund.account && credit.amountMinor === refund.amountMinor &&
    credit.currency === refund.currency && credit.direction === 'incoming' &&
    credit.status === 'posted' && Number.isFinite(evidenceInstant(credit.postedAt));
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

export function checkRefund(record, fixture, now, checkpointId) {
  const subject = fixture.subject;
  const allowed = (source, at = now) => {
    const grant = record.refundAccess?.[source];
    return grant?.operation === 'read' && refundAccess(grant, at) === 'allowed' &&
      Object.entries(refundScope(subject, source)).every(([field, value]) => grant.scope?.[field] === value);
  };
  const history = record.refundCheckpoints ?? [];
  if ((checkpointId !== undefined && history.includes(checkpointId)) || !refundSources.some(source => allowed(source))) return record;

  const checks = { ...record.checks };
  let attempted = false;
  let checkedAt = now.toISOString();
  const authorizeRead = source => at => {
    if (!allowed(source, at)) return false;
    checkedAt = at.toISOString();
    return true;
  };
  let retryAvailable = true;
  function readWithRetry(read) {
    let failed = false;
    while (true) {
      try {
        const result = read();
        return failed && result === undefined ? null : result;
      } catch (error) {
        if (!(error instanceof RefundFeedUnavailable)) throw error;
        if (!retryAvailable) return null;
        retryAvailable = false;
        failed = true;
      }
    }
  }

  function saveCheck(source, successful, lastEventAt) {
    attempted = true;
    const previous = checks[source];
    const previousEventAt = Number.isFinite(evidenceInstant(previous?.lastEventAt)) ? previous.lastEventAt : null;
    checks[source] = {
      checkedAt: successful ? checkedAt : previous?.checkedAt ?? null,
      lastEventAt: lastEventAt ?? previousEventAt,
      status: successful ? 'checked' : 'unavailable',
      ...(checkpointId !== undefined ? { checkpointId } : {})
    };
  }

  let { merchantEvent = null } = record;
  let links = [];
  let credit = null;
  if (allowed('merchant')) {
    const merchant = readWithRetry(() => fixture.readMerchant(refundScope(subject, 'merchant'), authorizeRead('merchant')));
    links = merchant?.links ?? [];
    merchantEvent = latestEvidence(merchant?.events ?? [], 'occurredAt', merchantEvent);
    if (merchant !== undefined) saveCheck('merchant', Boolean(merchant), merchantEvent?.occurredAt);
  }
  if (allowed('credits')) {
    const credits = readWithRetry(() => fixture.readCredits({
      ...refundScope(subject, 'credits'),
      linkedCreditIds: links.map(link => link.creditId)
    }, authorizeRead('credits')));
    if (credits) credit = matchRefundCredit(subject, { credits, links });
    const lastEventAt = latestEvidence(credits ?? [], 'postedAt', { postedAt: checks.credits?.lastEventAt })?.postedAt;
    if (credits !== undefined) saveCheck('credits', Boolean(credits), lastEventAt);
  }
  if (!attempted) return record;
  return {
    ...record,
    merchantEvent,
    checks,
    ...(checkpointId !== undefined ? { refundCheckpoints: [...history, checkpointId] } : {}),
    status: credit ? 'verified' : record.status,
    evidence: credit
      ? [{ source: 'credits', reference: credit.id, amountMinor: credit.amountMinor, currency: credit.currency, postedAt: credit.postedAt }]
      : record.evidence
  };
}
