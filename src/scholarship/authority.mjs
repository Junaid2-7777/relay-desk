import { evidenceInstant } from '../../shared/evidence-time.mjs';

const roles = ['student', 'institute', 'district'];
const basicFields = ['id', 'caseId', 'sequence', 'issuer', 'issuerRole', 'type', 'stage', 'receiptRef', 'recordedAt'];
const rules = {
  submitted: { role: 'student', stage: 'application', fields: [] },
  returned_for_correction: { role: 'institute', stage: 'L1', fields: ['reason'] },
  correction_submitted: { role: 'student', stage: 'L1', fields: ['returnId'] },
  correction_acknowledged: { role: 'institute', stage: 'L1', fields: ['returnId', 'submissionId'] },
  institute_verified: { role: 'institute', stage: 'L1', fields: [] },
  district_verified: { role: 'district', stage: 'L2', fields: [] }
};
const ownerOf = { unfiled: null, L1: 'institute', correction: 'student', L2: 'district', verified: null };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,99}$/iu.test(value);

function validateCase(caseScope) {
  const { caseId, issuers } = caseScope ?? {};
  if (!identifier(caseId) || !object(issuers) || Object.keys(issuers).length !== roles.length ||
      !roles.every(role => Object.hasOwn(issuers, role) && identifier(issuers[role])) ||
      new Set(roles.map(role => issuers[role])).size !== roles.length) {
    throw new TypeError('Provide one synthetic case and distinct student, institute, and district issuer identifiers.');
  }
}

function typedReceipt(raw) {
  if (!object(raw) || typeof raw.type !== 'string' || !Object.hasOwn(rules, raw.type)) return null;
  const fields = [...basicFields, ...rules[raw.type].fields];
  if (Object.keys(raw).length !== fields.length || !fields.every(field => Object.hasOwn(raw, field)) ||
      !['id', 'caseId', 'issuer', 'issuerRole', 'stage', 'receiptRef'].every(field => identifier(raw[field])) ||
      !Number.isSafeInteger(raw.sequence) || raw.sequence < 1 || !Number.isFinite(evidenceInstant(raw.recordedAt))) return null;
  for (const field of rules[raw.type].fields) {
    if (field === 'reason') {
      if (typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 500) return null;
    } else if (!identifier(raw[field])) {
      return null;
    }
  }
  return Object.fromEntries(fields.map(field => [field, raw[field]]));
}

function authorityIssue(receipt, { caseId, issuers }) {
  const rule = rules[receipt.type];
  if (receipt.caseId !== caseId) return 'wrong-case';
  if (receipt.issuerRole !== rule.role || receipt.issuer !== issuers[rule.role]) return 'wrong-authority';
  return receipt.stage === rule.stage ? null : 'wrong-stage';
}

function applyReceipt(state, returns, receipt) {
  switch (receipt.type) {
    case 'submitted':
      if (state.stage !== 'unfiled') return 'invalid-transition';
      state.filing = receipt;
      state.stage = 'L1';
      break;
    case 'returned_for_correction':
      if (state.stage !== 'L1') return 'invalid-transition';
      state.correction = { request: receipt, submission: null, acknowledgement: null };
      returns.set(receipt.id, state.correction);
      state.stage = 'correction';
      break;
    case 'correction_submitted':
      if (state.stage !== 'correction') return 'invalid-transition';
      if (receipt.returnId !== state.correction.request.id) return 'wrong-correction';
      state.correction.submission = receipt;
      state.stage = 'L1';
      break;
    case 'correction_acknowledged': {
      const earlier = returns.get(receipt.returnId);
      if (earlier?.submission?.id !== receipt.submissionId) return 'wrong-submission';
      if (earlier === state.correction && state.stage === 'L1' && !earlier.acknowledgement) {
        earlier.acknowledgement = receipt;
      } else {
        state.historicalAcknowledgements.push(receipt);
      }
      break;
    }
    case 'institute_verified':
      if (state.stage !== 'L1') return 'invalid-transition';
      state.instituteProof = receipt;
      state.stage = 'L2';
      break;
    case 'district_verified':
      if (state.stage !== 'L2' || !state.instituteProof) return 'invalid-transition';
      state.districtProof = receipt;
      state.stage = 'verified';
      break;
  }
  return null;
}

function review(code, receipt) {
  return { code, eventId: receipt?.id ?? null, sequence: receipt?.sequence ?? null };
}

export function foldScholarshipCase(caseScope, deliveries) {
  validateCase(caseScope);
  if (!Array.isArray(deliveries)) throw new TypeError('Supply ordered deliveries of synthetic case receipts.');
  const state = {
    caseId: caseScope.caseId, sequence: 0, stage: 'unfiled',
    filing: null, correction: null, instituteProof: null, districtProof: null, historicalAcknowledgements: [], review: null
  };
  const byId = new Map();
  const bySequence = new Map();
  const returns = new Map();
  for (const raw of deliveries) {
    const receipt = typedReceipt(raw);
    if (!receipt) {
      state.review = review('invalid-receipt');
      break;
    }
    const prior = byId.get(receipt.id);
    if (prior) {
      if (JSON.stringify(prior) === JSON.stringify(receipt)) continue;
      state.review = review('conflicting-event-id', receipt);
      break;
    }
    const issue = authorityIssue(receipt, caseScope);
    if (issue || bySequence.has(receipt.sequence)) {
      state.review = review(issue ?? 'conflicting-sequence', receipt);
      break;
    }
    byId.set(receipt.id, receipt);
    bySequence.set(receipt.sequence, receipt);
    while (bySequence.has(state.sequence + 1)) {
      const next = bySequence.get(state.sequence + 1);
      const transitionIssue = applyReceipt(state, returns, next);
      if (transitionIssue) {
        state.review = review(transitionIssue, next);
        break;
      }
      state.sequence += 1;
    }
    if (state.review) break;
  }
  if (!state.review && bySequence.size > state.sequence) {
    state.review = { code: 'sequence-gap', eventId: null, sequence: state.sequence + 1 };
  }
  return {
    ...state,
    owner: ownerOf[state.stage],
    awaitingAcknowledgement: state.stage === 'L1' &&
      Boolean(state.correction?.submission && !state.correction.acknowledgement)
  };
}
