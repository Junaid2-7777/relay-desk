import assert from 'node:assert/strict';
import test from 'node:test';
import { previewErrand, suggestPracticePlan } from '../src/intake.mjs';

const monday = '2026-11-23';

test('suggests Friday as the household check for the first-use refund', () => {
  const note = 'The shop said it would refund me. Can you help me check on Friday?';
  assert.deepEqual(previewErrand(note, monday), {
    kind: 'refund',
    goal: 'Check for my refund',
    checkDate: '2026-11-27',
  });
});

test('does not treat a reported promise or deadline as a chosen check', () => {
  assert.equal(previewErrand('The shop promised a refund on Friday.', monday).checkDate, null);
  assert.equal(previewErrand('The school needs the form by tomorrow.', monday).checkDate, null);
  assert.equal(previewErrand('Check whether my refund arrived on Friday.', monday).checkDate, null);
  assert.equal(previewErrand('The shop told me to check on Friday.', monday).checkDate, null);
  assert.equal(previewErrand('The shop note reads “Status pending. Check on Friday.”', monday).checkDate, null);
  assert.equal(previewErrand('Do not check Friday.', monday).checkDate, null);
  assert.equal(previewErrand('The shop said "check Monday." Could you check this on Friday?', monday).checkDate, '2026-11-27');
});

test('leaves competing or ambiguous check dates for the person to choose', () => {
  assert.equal(previewErrand('Check Friday or Saturday.', monday).checkDate, null);
  assert.equal(previewErrand('Check next Friday.', monday).checkDate, null);
  assert.equal(previewErrand('Check Friday. Follow up on Sunday.', monday).checkDate, null);
  assert.equal(previewErrand('Check Friday or 2026-11-28.', monday).checkDate, null);
});

test('handles explicit today, tomorrow and a weekday on the local clock', () => {
  assert.equal(previewErrand('Check again today.', monday).checkDate, monday);
  assert.equal(previewErrand('Follow up tomorrow.', '2026-12-31').checkDate, '2027-01-01');
  assert.equal(previewErrand('Check on Monday.', monday).checkDate, monday);
  assert.equal(previewErrand('Check the library account on Friday.', monday).checkDate, '2026-11-27');
  assert.equal(previewErrand('The shop promised a refund for my return. Help me check for the credit on Friday.', monday).checkDate, '2026-11-27');
  assert.equal(previewErrand('Please check on 2026-11-27.', monday).checkDate, '2026-11-27');
  assert.equal(previewErrand('Please check on 2026-11-31.', monday).checkDate, null);
});

test('suggests a practice reference only after a complete reference label', () => {
  assert.equal(suggestPracticePlan('The shop said it would refund me.', []).subject, '');
  assert.equal(suggestPracticePlan('Watch for the closure receipt with ref. #member-17.', []).subject, 'member-17');
  assert.equal(suggestPracticePlan('Watch for the receipt for reference number member-17, ID member-17.', []).subject, 'member-17');
  assert.equal(suggestPracticePlan('Watch for the receipt for reference member-17 or reference member-21.', []).subject, '');
  assert.equal(suggestPracticePlan('I need the receipt. Reference number not provided.', []).subject, '');
});
