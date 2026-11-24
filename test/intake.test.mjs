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
  assert.equal(previewErrand('Check Friday, Saturday or Sunday.', monday).checkDate, null);
  assert.equal(previewErrand('Check Friday morning or Saturday evening.', monday).checkDate, null);
  assert.equal(previewErrand('Check Friday and then Saturday.', monday).checkDate, null);
  assert.equal(previewErrand('Check Friday through Monday.', monday).checkDate, null);
  assert.equal(previewErrand('Check Friday, and check again on Monday.', monday).checkDate, null);
});

test('recognizes a household check after a comma and keeps other dates separate', () => {
  assert.equal(previewErrand('My parcel return is pending, please check again on Thursday.', monday).checkDate, '2026-11-26');
  assert.equal(previewErrand('The renewal was due on Tuesday, could you check the payment on Friday?', monday).checkDate, '2026-11-27');
  assert.equal(previewErrand('The clinic says the form is due on Tuesday, so follow up on Thursday.', monday).checkDate, '2026-11-26');
  assert.equal(previewErrand('Check Thursday, the provider promised Friday.', monday).checkDate, '2026-11-26');
});

test('does not extract a check from unquoted reported instructions after a comma', () => {
  assert.equal(previewErrand('The library says, please check on Friday.', monday).checkDate, null);
  assert.equal(previewErrand('The clinic wrote, if the form is missing, please check on Friday.', monday).checkDate, null);
  assert.equal(previewErrand('Vendor message: no confirmation yet, please check on Friday.', monday).checkDate, null);
  assert.equal(previewErrand('My return is pending, do not check on Friday.', monday).checkDate, null);
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

test('suggests a visit when the household directly asks for a booking', () => {
  assert.deepEqual(suggestPracticePlan('Could you book a free bicycle fitting for reference frame-32?', []), {
    capability: 'visit', subject: 'frame-32',
  });
  assert.equal(suggestPracticePlan('Please reserve a table for three.', []).capability, 'visit');
  assert.equal(suggestPracticePlan('My day has opened up. Help me schedule a consultation with the vet.', []).capability, 'visit');
  assert.equal(suggestPracticePlan('Please book a free equipment induction on Tuesday for reference course-8.', []).capability, 'visit');
  assert.equal(suggestPracticePlan('Book me a bike repair tomorrow.', []).capability, 'visit');
  assert.equal(suggestPracticePlan('Reserve the ceramics kiln.', []).capability, 'visit');
});

test('does not suggest booking from nouns, reported instructions or an explicit refusal', () => {
  for (const note of [
    'The library book is due next week.',
    'My reserve is low and the schedule changed.',
    'The clinic note reads “Book an exam tomorrow.”',
    "The clinic wrote 'I can't reserve it. Book a slot.'",
    'The clinic gave these instructions:\nBook a visit online.',
    'The clinic told me to book a visit.',
    'Do not book a fitting. Watch for my receipt.',
    'Book a fitting. Actually, don’t book yet.',
    'Reserve a copy of the tour guide for me.',
    'Schedule a reminder for my appointment.',
    'Schedule a bill payment for Thursday.',
    'Please reserve a library book Friday.',
    'Please see whether I can book a fitting.',
  ]) assert.equal(suggestPracticePlan(note, []).capability, 'receipt', note);
});
