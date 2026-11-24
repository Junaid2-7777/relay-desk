import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { openBillFixture } from '../src/bill-fixture.mjs';
import { openRefundFixture } from '../src/refund-fixture.mjs';
import { openVisitFixture } from '../src/visit-fixture.mjs';
import {
  createManualMorning, cutoff, inspectFixtures, ManualStepError, morning, morningClock, permissionTargets
} from './morning-manual.mjs';

const usage = 'Use npm run manual:session -- cold or npm run manual:session -- warm.';
const sources = [...permissionTargets.keys()].join(' | ');
const sourceLabels = {
  availability: 'calendar availability', slots: 'broadband offers and booking receipts', booking: 'submitting a free broadband booking',
  calendar: 'the calendar entry for this visit', shop: 'the shop return thread', credits: 'incoming credits for this return', bill: 'the electricity invoice'
};
const help = `reminders   Read the starting reminders for the participant.
allow SOURCE / decline SOURCE   Record the participant’s permission choice.
look SOURCE   Check the named source with its current permission.
  SOURCE: ${sources}
  look booking checks the provider receipt. look calendar checks the entry and its interval.
choose OFFER-ID   Select the exact displayed appointment terms.
book OFFER-ID   Submit the selected terms to the practice provider.
add calendar   Add the independently confirmed reservation to the practice calendar.
finish   Close the first-morning session and print the trace.`;
const reminders = `Electricity bill. The last known amount was ₹850, and the standing cap is ₹900.
Broadband visit. One free appointment on Tuesday from noon to 6 pm, around existing commitments.
Shop return. The shop expected a refund. Check again on Friday if the credit is still unverified.`;

function money(amountMinor, currency) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amountMinor / 100);
}

const localTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
});
const intervalText = ({ start, end }) => `${localTime.formatRange(new Date(start), new Date(end))} IST`;
const offerText = offer => `${offer.id} · ${intervalText(offer)} · free (${money(offer.feeMinor, offer.currency)}) · revision ${offer.revision}`;

function invoiceDisplay({ previous, current, capMinor, decision }) {
  return [
    `${current.payeeLabel}. Last known invoice ${money(previous.amountMinor, previous.currency)} (revision ${previous.revision}).`,
    `Current invoice ${money(current.amountMinor, current.currency)} (revision ${current.revision}). Standing cap ${money(capMinor, previous.currency)}.`,
    decision
  ].filter(Boolean).join('\n');
}

const sourceDisplay = {
  bill: invoiceDisplay,
  availability: ({ window, busy }) => [`Calendar availability for ${intervalText(window)}.`,
    ...(busy.length ? busy.map(interval => `Busy ${intervalText(interval)}.`) : ['No busy time in this window.'])].join('\n'),
  slots: ({ offers }) => ['Free practice broadband offers in the requested window.',
    ...(offers.length ? offers.map(offerText) : ['No offers in this window.'])].join('\n'),
  booking: ({ booking, reservation, next }) => booking === 'confirmed'
    ? `The provider confirmed ${offerText({ ...reservation, id: reservation.slotId })}.`
    : `Booking is still unverified. ${next}`,
  calendar: ({ calendar, event, busy }) => calendar === 'verified'
    ? `The practice calendar lists the same appointment for ${intervalText(event)}.`
    : `The calendar entry is still unverified.${busy ? ` Busy ${intervalText(busy)}.` : ''}`,
  shop: ({ reference, events }) => [`Shop thread for ${reference}.`,
    ...(events.length ? events.map(event => `Shop recorded ${event.type === 'promise' ? 'a refund promise' : event.type} on ${localTime.format(new Date(event.occurredAt))} IST.`) : ['No events in this thread.'])].join('\n'),
  credits: ({ reference, match }) => match
    ? `The ledger confirms ${money(match.amountMinor, match.currency)} for ${reference}, posted ${localTime.format(new Date(match.postedAt))} IST.`
    : `No matching posted credit for ${reference}. The refund remains open.`
};

const blockedBooking = {
  'slot-scope': 'The offer no longer matches this visit.', 'slot-unavailable': 'The offer is no longer available.',
  'slot-revised': 'The offer terms changed.', 'slot-fee': 'The offer now has a fee.',
  'outside-window': 'The offer is outside the permitted window.', 'calendar-conflict': 'The calendar now shows busy time during this offer.',
  permission: 'Permission no longer covers these terms.'
};

function applyCommand(task, line, write) {
  const command = line.trim();
  if (!command) return;
  if (command === 'finish') return 'finished';
  if (command === 'help') return write(help);
  if (command === 'reminders') return write(reminders);

  const [verb, word, ...remaining] = command.split(/\s+/u);
  if (!word || remaining.length) throw new ManualStepError('Command not recognized. Type help to see the available commands.');
  if ((verb === 'allow' || verb === 'decline') && permissionTargets.has(word)) {
    const { choice, alreadyRecorded } = task.consent({ ...permissionTargets.get(word), choice: verb === 'allow' ? 'allowed' : 'declined' });
    write(`${alreadyRecorded ? 'Already' : 'Access'} ${choice} for ${sourceLabels[word]}.`);
  } else if (verb === 'look' && permissionTargets.has(word)) {
    write(sourceDisplay[word](task.look(word)));
  } else if (verb === 'choose') {
    const { selected, next } = task.choose(word);
    write(`Selected ${offerText(selected)} for the household broadband service. ${next}`);
  } else if (verb === 'book') {
    const { booking, reason, next } = task.book(word);
    write(booking === 'submitted' ? `Booking submitted. ${next}` : `${blockedBooking[reason] ?? 'The booking could not be completed.'} ${next}`);
  } else if (verb === 'add' && word === 'calendar') {
    const { calendar, busy, next } = task.addCalendar();
    const status = calendar === 'submitted' ? 'Calendar entry submitted.' : busy
      ? `The practice calendar has busy time for ${intervalText(busy)}.` : 'The calendar entry could not be added.';
    write(`${status} ${next}`);
  } else {
    throw new ManualStepError('Command not recognized. Type help to see the available commands.');
  }
}

function independentReadback(initial, native, { visit, bill, refund }) {
  const managedEvents = native.visit.calendar.filter(event => event.reservationId);
  const reservationMatched = native.visit.reservations.some(row => isDeepStrictEqual(row, visit.reservation));
  const calendarMatched = reservationMatched && managedEvents.some(row => isDeepStrictEqual(row, visit.calendarEvent));
  const recordedCredit = refund.evidence[0];
  return {
    protectedCalendarUnchanged: isDeepStrictEqual(initial.visit.calendar, native.visit.calendar.filter(event => !event.reservationId)),
    reservations: native.visit.reservations.length,
    calendarWrites: managedEvents.length,
    payments: native.bill.payments.length,
    ledgerReads: native.refund.reads.filter(row => row.source === 'credits').length,
    matchedNativeEvidence: {
      reservation: reservationMatched, calendar: calendarMatched,
      invoice: native.bill.reads.some(row => row.source === 'invoice') && native.bill.invoices.some(row => isDeepStrictEqual(row, bill.invoice)),
      refundCredit: Boolean(recordedCredit && native.refund.credits.some(row => isDeepStrictEqual(row, recordedCredit)))
    }
  };
}

function sessionTrace(task, fixtures, initial, scenario, end) {
  const native = inspectFixtures(fixtures);
  const { actions, outcomes } = task;
  return {
    evaluation: 'facilitated-r1-manual-session', scenario, clock: morning, cutoff, end,
    fixtureInputHash: createHash('sha256').update(JSON.stringify(initial)).digest('hex'),
    actions: { setup: actions.setup, ongoing: actions.ongoing }, counts: actions.counts({ scripted: false }),
    outcomes: {
      visit: outcomes.visit.status,
      bill: { status: outcomes.bill.status, decisionPresented: outcomes.bill.issue === 'bill-review' },
      refund: outcomes.refund.status
    },
    independentReadback: independentReadback(initial, native, outcomes),
    nativeReadCounts: Object.fromEntries(Object.entries(native).map(([name, trace]) => [name, trace.reads.length])),
    writeAttempts: {
      reservations: native.visit.attempts.filter(row => row.operation === 'reserve').length,
      calendarWrites: native.visit.attempts.filter(row => row.operation === 'calendar.add').length,
      payments: native.bill.attempts.length
    }
  };
}

export async function runManualSession(scenario, { input = process.stdin, output = process.stdout } = {}) {
  if (!['cold', 'warm'].includes(scenario)) throw new TypeError(usage);
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-manual-session-'));
  const write = message => output.write(`${message}\n`);
  const fixtures = {};
  let reader;
  try {
    const options = { dataDir, clock: morningClock };
    fixtures.bill = openBillFixture(options);
    fixtures.refund = openRefundFixture(options);
    fixtures.visit = openVisitFixture(options);
    for (const fixture of Object.values(fixtures)) fixture.reset();
    const initial = inspectFixtures(fixtures);
    const warm = scenario === 'warm';
    const task = createManualMorning(fixtures, warm);

    write(`Manual first-morning session · ${scenario} · ${morning}`);
    write(warm ? 'The practice permissions have already been given.' : 'Start by asking before using any source.');
    write('This comparison ends before the bill decision is taken. Use synthetic inputs only. Type help for commands.');
    const terminal = Boolean(input.isTTY && output.isTTY);
    reader = createInterface({ input, output, terminal, historySize: 0 });
    if (terminal) reader.setPrompt('manual> ');
    reader.on('SIGINT', () => reader.close());
    if (terminal) reader.prompt();
    let end = 'input-closed';
    for await (const line of reader) {
      try {
        if (applyCommand(task, line, write) === 'finished') {
          end = 'finished';
          break;
        }
      } catch (error) {
        if (!(error instanceof ManualStepError)) throw error;
        write(error.message);
      }
      if (terminal) reader.prompt();
    }
    const report = sessionTrace(task, fixtures, initial, scenario, end);
    write('Session trace');
    write(JSON.stringify(report, null, 2));
    return report;
  } finally {
    reader?.close();
    for (const fixture of Object.values(fixtures)) fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
  } else if (args.length !== 1 || !['cold', 'warm'].includes(args[0])) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    try {
      await runManualSession(args[0]);
    } catch {
      console.error('The practice session could not complete. Start a fresh manual session.');
      process.exitCode = 1;
    }
  }
}
