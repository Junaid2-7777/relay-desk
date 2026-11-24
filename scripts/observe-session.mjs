import { isDeepStrictEqual } from 'node:util';
import { reviewNeeded } from '../shared/brief-order.mjs';
import { grantStateAt } from '../shared/grant-time.mjs';
import { matchedReadbacks, nativeEffects, supportedDecision } from './compare-planners.mjs';

const providers = ['refund', 'visit', 'bill', 'receipt', 'outbox'];
const operations = ['merchant', 'credits', 'freeBusy', 'slots', 'reserve', 'calendar', 'invoice', 'payment', 'receipt'];
const readSources = ['merchant', 'credits', 'freeBusy', 'slots', 'reservation', 'calendar', 'calendarConflict', 'invoice', 'payment', 'settlement', 'receipt'];
const empty = () => ({
  refund: { reads: [], links: [], credits: [] }, receipt: { reads: [], receipts: [] },
  visit: { reads: [], attempts: [], reservations: [], calendar: [] },
  bill: { reads: [], attempts: [], payments: [], settlements: [], invoices: [] },
  outbox: { attempts: [], messages: [] }
});

class ObservationError extends Error {}

function participantSnapshot(brief, native) {
  const reads = Object.fromEntries(readSources.map(source => [source, 0]));
  const unavailable = {};
  for (const provider of providers) {
    for (const read of native[provider].reads ?? []) {
      const source = provider === 'receipt' ? 'receipt' : read.source;
      if (!Object.hasOwn(reads, source)) throw new ObservationError('The running desk has an unrecognized provider read. Use its matching checkout.');
      reads[source]++;
      if (read.status === 'unavailable') unavailable[source] = (unavailable[source] ?? 0) + 1;
    }
  }
  const attempts = native.visit.attempts;
  return {
    observation: 'local-session-checkpoint',
    desk: brief.household ? 'practice-household' : brief.fixture ? 'refund-practice' : 'private',
    planner: brief.plannerMode ?? 'fixed-rule',
    deskTime: brief.now,
    errands: brief.errands.map(record => {
      const permissions = {};
      for (const operation of operations) {
        const grant = (record.refundAccess ?? record.grants)?.[operation];
        if (grant) permissions[operation] = grantStateAt(grant, brief.now);
      }
      return {
        kind: record.kind, status: record.status, checkDate: record.checkDate, permissions,
        decisionReady: reviewNeeded(record, brief.now) && supportedDecision(record, native, brief.now) ? record.issue : null,
        matchedNativeEvidence: matchedReadbacks(record, native)
      };
    }),
    providerReads: reads,
    unavailableReads: unavailable,
    writeAttempts: {
      reservations: attempts.filter(row => row.operation === 'reserve').length,
      calendarWrites: attempts.filter(row => row.operation === 'calendar.add').length,
      payments: native.bill.attempts.length, queuedMessages: native.outbox.attempts.length
    },
    committedEffects: nativeEffects(native).counts
  };
}

async function collect(port) {
  const origin = `http://127.0.0.1:${port}`;
  const get = async (path, context) => {
    const response = await fetch(origin + path, {
      headers: context ? { 'X-Relay-Desk': context } : {},
      redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    if (response.status === 409) throw new ObservationError('The desk changed during observation. Capture the new checkpoint again.');
    if (!response.ok) throw new ObservationError('The running desk could not supply its inspection records.');
    return response.json();
  };
  const brief = await get('/api/desk');
  if (typeof brief.deskContext !== 'string' || !brief.deskContext || !Array.isArray(brief.errands)) {
    throw new ObservationError('The running desk does not supply a session identity. Use its matching checkout.');
  }
  const sources = brief.household ? providers : brief.fixture ? ['refund'] : [];
  async function readFixtures() {
    const entries = await Promise.all(sources.map(async name => [name, await get(`/api/fixture/${name}`, brief.deskContext)]));
    return Object.assign(empty(), Object.fromEntries(entries));
  }
  const native = await readFixtures();
  const finalNative = await readFixtures();
  const current = await get('/api/desk', brief.deskContext);
  if (brief.deskContext !== current.deskContext || !isDeepStrictEqual(brief.errands, current.errands) ||
      !isDeepStrictEqual(native, finalNative)) {
    throw new ObservationError('An errand or provider record changed during observation. Capture the new checkpoint again.');
  }
  return participantSnapshot(brief, native);
}

const args = process.argv.slice(2);
const port = Number(process.env.RELAY_PORT ?? 4173);
if (args.length === 1 && args[0] === '--help') {
  console.log('Run npm run --silent observe:session while the desk is open. Set RELAY_PORT to observe a different local port.');
} else if (args.length || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Use npm run observe:session with RELAY_PORT set to the running local desk port (1–65535).');
  process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(await collect(port), null, 2));
  } catch (error) {
    console.error(error instanceof ObservationError ? error.message : `Could not read the local desk on port ${port}. Check that Relay Desk is running.`);
    process.exitCode = 1;
  }
}
