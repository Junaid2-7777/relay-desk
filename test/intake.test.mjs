import assert from 'node:assert/strict';
import test from 'node:test';
import {previewErrand} from '../src/intake.mjs';

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
});

test('leaves competing or ambiguous check dates for the person to choose', () => {
  assert.equal(previewErrand('Check Friday or Saturday.', monday).checkDate, null);
  assert.equal(previewErrand('Check next Friday.', monday).checkDate, null);
  assert.equal(previewErrand('Check Friday. Follow up on Sunday.', monday).checkDate, null);
});

test('handles explicit today, tomorrow and a weekday on the local clock', () => {
  assert.equal(previewErrand('Check again today.', monday).checkDate, monday);
  assert.equal(previewErrand('Follow up tomorrow.', '2026-12-31').checkDate, '2027-01-01');
  assert.equal(previewErrand('Check on Monday.', monday).checkDate, monday);
  assert.equal(previewErrand('Check the library account on Friday.', monday).checkDate, '2026-11-27');
});
