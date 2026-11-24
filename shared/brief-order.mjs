export const reviewNeeded = record => !['verified', 'stopped'].includes(record.status) &&
  (record.issue === 'bill-review' || record.issue === 'calendar-conflict');

function priority(record) {
  if (record.status === 'verified') return 2;
  if (record.status === 'stopped') return 3;
  return reviewNeeded(record) ? 0 : 1;
}

function compareChecks(left, right) {
  return priority(left) - priority(right) ||
    Number(!left.checkDate) - Number(!right.checkDate) ||
    (left.checkDate ?? '').localeCompare(right.checkDate ?? '');
}

export function orderChecks(records, household) {
  return records.sort((left, right) => compareChecks(left, right) || (household ? left.id.localeCompare(right.id) : 0));
}
