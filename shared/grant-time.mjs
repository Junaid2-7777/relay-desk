import { zonedInstant } from './evidence-time.mjs';

export const standingGrantMs = 7 * 24 * 60 * 60 * 1000;
export const billApprovalMs = 15 * 60 * 1000;

export function grantStateAt(grant, now) {
  if (grant?.status !== 'allowed') return grant?.status ?? 'unasked';
  const instant = typeof now === 'string' ? zonedInstant(now) : now == null ? NaN : +now;
  const expiry = zonedInstant(grant.expiresAt);
  if (!Number.isFinite(instant) || !Number.isFinite(expiry) || instant >= expiry) return 'expired';
  // Existing desks store the expiry and issue every grant for one of these two fixed periods.
  const duration = Object.hasOwn(grant, 'grantRevision') ? billApprovalMs : standingGrantMs;
  return instant < expiry - duration ? 'not-yet-active' : 'allowed';
}

export const grantActiveAt = (grant, now) => grantStateAt(grant, now) === 'allowed';
