import assert from 'node:assert/strict';
import test from 'node:test';
import { PlannerProposalError, validatePlannerProposal } from '../src/planner-proposal.mjs';

const goal = 'Confirm the library membership has closed';
const receipt = { capability: 'receipt', issuer: 'future-library', subject: 'membership-201', type: 'membership', status: 'closed' };
const visit = {
  capability: 'visit', issuer: 'community-centre', subject: 'orientation-5', service: 'orientation',
  windowStart: '2026-11-24T14:00+05:30', windowEnd: '2026-11-24T10:30Z'
};
const proposal = (practicePlan, checkDate = null) => ({ goal, checkDate, practicePlan });

test('keeps unknown issuers as reviewable identifier data', () => {
  assert.deepEqual(validatePlannerProposal({ goal: ` ${goal} `, checkDate: '2026-11-27', practicePlan: receipt }), {
    goal, checkDate: '2026-11-27', practicePlan: receipt
  });
  assert.deepEqual(validatePlannerProposal(proposal(visit)), proposal(visit));
  assert.deepEqual(validatePlannerProposal(proposal(null)), proposal(null));
});

test('represents incomplete plans as editable fields with no automatic date', () => {
  const uncertain = { ...receipt, issuer: null, subject: null, status: null };
  assert.deepEqual(validatePlannerProposal(proposal(uncertain)), proposal({ ...uncertain, issuer: '', subject: '', status: '' }));
  const partial = { ...visit, windowStart: null };
  assert.deepEqual(validatePlannerProposal(proposal(partial)), proposal({ ...partial, windowStart: '' }));
});

test('rejects inherited, extra, and executable fields with a value-free error', () => {
  let getterRan = false;
  const getter = Object.defineProperty(proposal(receipt), 'goal', { get() { getterRan = true; return goal; } });
  const invalid = [
    null, [], new Date(), Object.create(proposal(receipt)),
    { ...proposal(receipt), permission: 'secret-value' },
    proposal({ ...receipt, grant: 'secret-value' }),
    proposal({ ...receipt, capability: 'pay' }),
    proposal({ ...visit, type: 'extra-field' }),
    proposal({ capability: 'receipt', issuer: null }),
    proposal({ ...receipt, subject: 'long/'.repeat(100) }), getter
  ];
  for (const value of invalid) {
    assert.throws(() => validatePlannerProposal(value), {
      name: 'PlannerProposalError', message: 'The planner returned an invalid proposal.'
    });
  }
  assert.equal(getterRan, false);
});

test('checks real calendar dates and compares zoned visit windows by instant', () => {
  assert.doesNotThrow(() => validatePlannerProposal(proposal(receipt, '2028-02-29')));
  assert.throws(() => validatePlannerProposal(proposal(receipt, '2026-02-29')), PlannerProposalError);
  for (const windowEnd of ['2026-11-24T14:30', '2026-11-24T08:30Z', '2026-11-31T18:00Z', '2027-02-02T18:00Z']) {
    assert.throws(() => validatePlannerProposal(proposal({ ...visit, windowEnd })), PlannerProposalError);
  }
});
