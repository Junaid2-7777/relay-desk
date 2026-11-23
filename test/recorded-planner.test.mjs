import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordedPlanner } from '../src/recorded-planner.mjs';

const note = 'Check whether my practice membership closed.';

function entry() {
  return {
    note: ` ${note}\n`,
    recordedProposal: {
      goal: 'Confirm my membership is closed', checkDate: null,
      practicePlan: {
        capability: 'receipt', issuer: 'practice-library', subject: 'test-member-1', type: 'membership', status: 'closed'
      }
    }
  };
}

test('matches exact trimmed notes and returns independent copies of recorded proposals', () => {
  const data = entry();
  const { mode, propose } = createRecordedPlanner([{ ...data, expectedInterpretation: 'grader-only' }]);
  assert.equal(mode, 'recorded-response');
  const expected = structuredClone(data.recordedProposal);
  data.recordedProposal.practicePlan.status = 'changed outside planner';
  const first = propose({ note });
  assert.deepEqual(first, expected);
  first.practicePlan.status = 'changed by caller';
  assert.deepEqual(propose({ note: `\t${note} ` }), expected);
  assert.throws(() => propose({ note: note.toLowerCase() }), /No recorded proposal/);
  assert.throws(() => propose({ note: 'A different errand' }), /No recorded proposal/);
});

test('refuses duplicate trimmed note entries and incomplete entries', () => {
  assert.throws(() => createRecordedPlanner([entry(), { ...entry(), note }]), /duplicate note/);
  assert.throws(() => createRecordedPlanner([{ note }]), /needs a note and a proposal/);
});
