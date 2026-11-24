const zonedTimestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

export function evidenceInstant(value) {
  if (typeof value !== 'string' || !zonedTimestamp.test(value)) return NaN;
  const day = value.slice(0, 10);
  const midnight = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(+midnight) && midnight.toISOString().slice(0, 10) === day ? Date.parse(value) : NaN;
}

export function latestEvidence(records, timestampField, previous = null) {
  const previousAt = evidenceInstant(previous?.[timestampField]);
  let latestAt = Number.isFinite(previousAt) ? previousAt : -Infinity;
  let latest = latestAt === -Infinity ? null : previous;
  for (const record of records) {
    const at = evidenceInstant(record[timestampField]);
    if (at >= latestAt) {
      latestAt = at;
      latest = record;
    }
  }
  return latest;
}
