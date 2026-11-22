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
