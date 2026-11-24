import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PlannerProposalError, validatePlannerProposal } from './planner-proposal.mjs';

const maximumReviews = 128;
const reviewLifetimeMs = 15 * 60 * 1000;
const maximumActive = 4;
const candidateModes = new Set(['recorded-response', 'n8n']);

export function createIntakePlanner(candidate) {
  const timeoutMs = candidate?.timeoutMs ?? 12_000;
  if (candidate && (!candidateModes.has(candidate.mode) || typeof candidate.propose !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)) {
    throw new TypeError('Supply a practice planner with a supported mode and a bounded deadline.');
  }
  const reviews = new Map();
  let active = 0;

  async function suggest(input, fixed) {
    const baseline = { ...fixed, plannerMode: 'fixed-rule', plannerStatus: 'proposed' };
    if (!candidate) return baseline;
    const fallback = plannerFailure => ({ ...baseline, plannerStatus: 'fallback', plannerFailure });
    if (active >= maximumActive) return fallback('unavailable');

    const controller = new AbortController();
    const deadline = Symbol('planner deadline');
    let timer;
    active++;
    const pending = Promise.resolve().then(() => candidate.propose({ ...input, signal: controller.signal }))
      .finally(() => { active--; });
    const expiration = new Promise(resolve => {
      timer = setTimeout(() => {
        resolve(deadline);
        controller.abort();
      }, timeoutMs);
    });
    try {
      const value = await Promise.race([pending, expiration]);
      if (value === deadline) return fallback('timeout');
      return { ...fixed, ...validatePlannerProposal(value), plannerMode: candidate.mode, plannerStatus: 'proposed' };
    } catch (error) {
      return fallback(error instanceof PlannerProposalError ? 'invalid-proposal' : 'unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mode: candidate?.mode ?? 'fixed-rule',
    async review(note, today, sources, fixed) {
      const sourceList = sources.map(({ issuer, label }) => ({ issuer, label }));
      const proposal = await suggest({ note, today, sources: sourceList }, fixed);
      const previewId = randomUUID();
      if (reviews.size >= maximumReviews) reviews.delete(reviews.keys().next().value);
      reviews.set(previewId, { note, proposal: structuredClone(proposal), expiresAt: performance.now() + reviewLifetimeMs });
      return { ...proposal, previewId };
    },
    reviewed(previewId, note) {
      const entry = reviews.get(previewId);
      if (!entry || entry.note !== note) return null;
      if (entry.expiresAt <= performance.now()) {
        reviews.delete(previewId);
        return null;
      }
      return structuredClone(entry.proposal);
    }
  };
}
