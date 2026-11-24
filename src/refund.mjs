import { createHash } from 'node:crypto';
import { evidenceInstant, latestEvidence } from '../shared/evidence-time.mjs';
import { grantStateAt as refundAccess, standingGrantMs } from '../shared/grant-time.mjs';

export { refundAccess };

function isPostedCredit(credit, refund, asOf) {
  return typeof credit.id === 'string' && credit.id.length > 0 &&
    credit.account === refund.account && credit.amountMinor === refund.amountMinor &&
    credit.currency === refund.currency && credit.direction === 'incoming' &&
    credit.status === 'posted' && evidenceInstant(credit.postedAt) <= asOf;
}

export function refundLinkVisibleAt(link, asOf) {
  return link.issuedAt == null || evidenceInstant(link.issuedAt) <= asOf;
}

function isLinked(credit, refund, links, asOf) {
  if (credit.returnReference !== null || !refund.merchantIssuer || !refund.thread) return false;
  const references = new Set(links
    .filter(link => link.issuer === refund.merchantIssuer && link.thread === refund.thread && link.creditId === credit.id &&
      refundLinkVisibleAt(link, asOf))
    .map(link => link.returnReference));
  return references.size === 1 && references.has(refund.reference);
}

export function matchRefundCredit(refund, {credits = [], links = []} = {}, asOf = Infinity) {
  if (!refund?.reference || !refund.account || !/^[A-Z]{3}$/u.test(refund.currency) ||
      !Number.isSafeInteger(refund.amountMinor) || refund.amountMinor <= 0) return null;

  const matches = credits.filter(credit => isPostedCredit(credit, refund, asOf) &&
    (credit.returnReference === refund.reference || isLinked(credit, refund, links, asOf)));
  return matches.length === 1 ? matches[0] : null;
}

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
    expiresAt: choice === 'allowed' ? new Date(+now + standingGrantMs).toISOString() : null
  };
}

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function checkRefund(record, fixture, now, checkpointId) {
  const subject = fixture.subject;
  const allowed = (source, at = now) => {
    const grant = record.refundAccess?.[source];
    return grant?.operation === 'read' && refundAccess(grant, at) === 'allowed' &&
      Object.entries(refundScope(subject, source)).every(([field, value]) => grant.scope?.[field] === value);
  };
  const history = record.refundCheckpoints ?? [];
  if ((checkpointId !== undefined && history.includes(checkpointId)) || !refundSources.some(source => allowed(source))) return record;

  const replay = checkpointId === undefined ? null : {
    key: fingerprint([record.id, checkpointId]),
    binding: fingerprint([record.revision, subject, refundSources.map(source => [allowed(source), record.refundAccess?.[source]])])
  };
  const checks = { ...record.checks };
  let attempted = false;
  let retryAvailable = true;
  function readWithRetry(source, scope) {
    const authorize = at => allowed(source, at) && (!scope.linkedCreditIds?.length || allowed('merchant', at));
    const read = attempt => fixture.readForCheck(source, scope, { authorize, ...(replay ? { replay: { ...replay, attempt } } : {}) });
    const first = read(1);
    if (first.status !== 'unavailable' || !retryAvailable) return first;
    retryAvailable = false;
    const retry = read(2);
    return retry.status === 'denied' ? first : retry;
  }

  function saveCheck(source, read, lastEventAt) {
    if (read.status === 'denied') return;
    attempted = true;
    const previous = checks[source];
    const asOf = read.checkedAt ? Date.parse(read.checkedAt) : +now;
    const previousEventAt = evidenceInstant(previous?.lastEventAt) <= asOf ? previous.lastEventAt : null;
    checks[source] = {
      checkedAt: read.checkedAt ?? previous?.checkedAt ?? null,
      lastEventAt: lastEventAt ?? previousEventAt,
      status: read.status,
      ...(checkpointId !== undefined ? { checkpointId } : {})
    };
  }

  let { merchantEvent = null } = record;
  let links = [];
  let credit = null;
  if (allowed('merchant')) {
    const read = readWithRetry('merchant', refundScope(subject, 'merchant'));
    if (read.status === 'superseded') return record;
    const merchant = read.records;
    const asOf = read.checkedAt ? Date.parse(read.checkedAt) : +now;
    links = (merchant?.links ?? []).filter(link => refundLinkVisibleAt(link, asOf));
    merchantEvent = latestEvidence(merchant?.events ?? [], 'occurredAt', merchantEvent, asOf);
    saveCheck('merchant', read, merchantEvent?.occurredAt);
  }
  if (allowed('credits')) {
    const read = readWithRetry('credits', {
      ...refundScope(subject, 'credits'),
      linkedCreditIds: links.map(link => link.creditId)
    });
    if (read.status === 'superseded') return record;
    const credits = read.records;
    const asOf = read.checkedAt ? Date.parse(read.checkedAt) : +now;
    if (credits) credit = matchRefundCredit(subject, { credits, links }, asOf);
    const lastEventAt = latestEvidence(credits ?? [], 'postedAt', { postedAt: checks.credits?.lastEventAt }, asOf)?.postedAt;
    saveCheck('credits', read, lastEventAt);
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
