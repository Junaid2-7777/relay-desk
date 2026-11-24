export function calendarConflictChoice(record) {
  const { conflictChoice, conflict, reservation } = record;
  if (!conflictChoice || !conflict || !reservation) return null;
  const { choice, reservationId, start, end } = conflictChoice;
  return (choice === 'handle' || choice === 'watch') && reservationId === reservation.id &&
    start === conflict.start && end === conflict.end ? choice : null;
}

export const reviewNeeded = record => !['verified', 'stopped'].includes(record.status) &&
  (record.issue === 'bill-review' || (record.issue === 'calendar-conflict' && !calendarConflictChoice(record)));

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
