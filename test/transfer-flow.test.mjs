import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openActionJournal } from '../src/action-journal.mjs';
import { openReceiptFixture, practiceReceiptSource } from '../src/receipt-fixture.mjs';
import { createDeskServer } from '../src/server.mjs';
import { mondayVisit, openVisitFixture } from '../src/visit-fixture.mjs';

const monday = '2026-11-23T03:30:00.000Z';
const friday = '2026-11-27T03:30:00.000Z';
const membershipProof = {
  issuer: practiceReceiptSource.issuer, subject: 'household-membership-301', type: 'membership', status: 'closed'
};

async function rehearsal(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-transfer-flow-'));
  const providers = [];
  let time = monday;
  let server;
  let url;
  const clock = () => new Date(time);

  async function close() {
    if (!server?.listening) return;
    const closed = once(server, 'close');
    server.close();
    await closed;
  }

  async function open(reset = false) {
    await close();
    server = createDeskServer({ dataDir, clock, householdMode: true, reset, warm: true });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
  }

  async function request(path, body, status = 200) {
    const method = body === undefined ? 'GET' : 'POST';
    const response = await fetch(url + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const detail = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${detail}`);
    return JSON.parse(detail);
  }

  t.after(async () => {
    await close();
    for (const provider of providers) provider.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await open(true);

  return {
    publish(...args) {
      const output = execFileSync(process.execPath, ['scripts/demo-evidence.mjs', ...args], {
        cwd: new URL('../', import.meta.url), encoding: 'utf8',
        env: { ...process.env, RELAY_DATA_DIR: dataDir, RELAY_CLOCK: time }
      });
      return JSON.parse(output);
    },
    provider(openFixture) {
      const provider = openFixture({ dataDir, clock });
      providers.push(provider);
      return provider;
    },
    async restart(nextTime) {
      time = nextTime;
      await open();
    },
    save: note => request('/api/errands', { note }, 201),
    brief: () => request('/api/desk'),
    setup: (errand, params, status) => request(`/api/errands/${errand.id}/setup`, { revision: errand.revision, ...params }, status),
    allow: (errand, operation) => request(`/api/errands/${errand.id}/household-access`, {
      revision: errand.revision, operation, choice: 'allowed'
    }),
    checkpoint: checkpointId => request('/api/checkpoint', { checkpointId }),
    inspect: () => request('/api/inspect')
  };
}

function recordFrom(brief, id) {
  const record = brief.errands.find(errand => errand.id === id);
  assert.ok(record, `Missing errand ${id}`);
  return record;
}

test('R7 rehearsal verifies a new receipt errand only from its authorized issuer and correlation', async t => {
  const desk = await rehearsal(t);
  const provider = desk.provider(openReceiptFixture);
  const note = 'I asked the library to close my membership. Can you help me check on Friday?';
  const saved = await desk.save(note);
  assert.equal(saved.status, 'open');
  assert.equal(saved.note, note);
  assert.equal(saved.checkDate, '2026-11-27');

  const configured = await desk.setup(saved, { capability: 'receipt', ...membershipProof });
  assert.equal(configured.id, saved.id);
  assert.equal(configured.goal, saved.goal);
  assert.equal(configured.note, note);
  assert.equal(configured.checkDate, saved.checkDate);
  assert.equal(configured.owner, practiceReceiptSource.label);
  assert.deepEqual(configured.receiptPlan, { ...membershipProof, available: true });
  assert.deepEqual(configured.grants ?? {}, {});
  const withoutGrant = recordFrom(await desk.checkpoint(), saved.id);
  assert.equal(withoutGrant.status, 'open');
  assert.deepEqual(provider.inspect().reads, []);

  const granted = await desk.allow(withoutGrant, 'receipt');
  const { issuer, subject } = membershipProof;
  assert.deepEqual(granted.grants.receipt.scope, { issuer, subject });
  const matching = { ...membershipProof, id: 'rehearsal-closure-301', occurredAt: friday };
  const wrongIssuer = 'library-other-authority';
  const unrelatedSubject = 'private-unrelated-library-membership';
  provider.putSource({ issuer: wrongIssuer, label: 'Other practice library' });
  provider.putReceipt({ ...matching, issuer: wrongIssuer, occurredAt: monday });
  provider.putReceipt({ ...matching, id: 'off-scope-receipt', subject: unrelatedSubject, occurredAt: monday });
  provider.putReceipt({
    ...matching, id: 'membership-request-received', type: 'acknowledgement', status: 'received', occurredAt: monday
  });

  const first = await desk.checkpoint();
  const pending = recordFrom(first, saved.id);
  assert.equal(pending.status, 'open');
  assert.equal(pending.issue, 'receipt-pending');
  assert.equal(pending.receiptProof, null);
  assert.ok(!JSON.stringify(first).includes(unrelatedSubject));
  assert.deepEqual(provider.inspect().reads, [{ issuer, subject, checkedAt: monday }]);

  await desk.restart(friday);
  assert.equal(recordFrom(await desk.checkpoint(), saved.id).status, 'open');
  provider.putReceipt(matching);
  const verified = recordFrom(await desk.checkpoint(), saved.id);
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.receiptProof, matching);
  assert.deepEqual(provider.inspect().receipts.find(row => row.issuer === issuer && row.id === matching.id), matching);
  assert.deepEqual(provider.inspect().reads.map(({ issuer, subject }) => ({ issuer, subject })), [
    { issuer, subject }, { issuer, subject }, { issuer, subject }
  ]);
});

test('R7 rehearsal retains an unsupported errand with its missing evidence and no source read', async t => {
  const desk = await rehearsal(t);
  const provider = desk.provider(openReceiptFixture);
  const note = 'The community archive agreed to return my donated records. Can you help me check on Friday?';
  const saved = await desk.save(note);
  const unsupportedProof = { issuer: 'community-archive-unconnected', subject: 'handback-421', type: 'record-return', status: 'issued' };
  const configured = await desk.setup(saved, { capability: 'receipt', ...unsupportedProof });
  assert.deepEqual(configured.receiptPlan, { ...unsupportedProof, available: false });

  const open = recordFrom(await desk.checkpoint(), saved.id);
  assert.equal(open.status, 'open');
  assert.equal(open.issue, 'evidence-needed');
  assert.equal(open.note, note);
  assert.equal(open.checkDate, saved.checkDate);
  assert.equal(open.receiptProof ?? null, null);
  assert.deepEqual(open.grants ?? {}, {});
  assert.deepEqual(provider.inspect().reads, []);
  assert.deepEqual((await desk.inspect()).actions.filter(action => action.errandId === saved.id), []);
});

test('a disconnected issuer preserves the last successful check and cannot verify a receipt until reconnection', async t => {
  const desk = await rehearsal(t);
  const provider = desk.provider(openReceiptFixture);
  const saved = await desk.save('Check the practice membership on Friday.');
  const plan = { ...membershipProof, issuer: 'practice-fitness-office' };
  const configured = await desk.setup(saved, { ...plan, capability: 'receipt' });
  assert.equal(configured.issue, 'evidence-needed');
  assert.deepEqual(desk.publish('receipt-source', plan.issuer, 'Practice fitness office'), {
    issuer: plan.issuer, label: 'Practice fitness office'
  });
  const available = recordFrom(await desk.checkpoint('discover'), saved.id);
  assert.equal(available.owner, 'Practice fitness office');
  assert.equal(available.issue, 'receipt-permission');
  assert.deepEqual(provider.inspect().reads, []);
  await desk.allow(available, 'receipt');
  desk.publish('receipt-record', plan.issuer, plan.subject, 'acknowledgement', 'received', 'practice-ack');
  const waiting = recordFrom(await desk.checkpoint('initial'), saved.id);
  assert.deepEqual(waiting.receiptCheck, { checkedAt: monday, lastEventAt: monday });
  assert.deepEqual(desk.publish('receipt-offline', plan.issuer), { issuer: plan.issuer, available: false });
  await desk.restart(friday);
  const receipt = desk.publish('receipt-record', plan.issuer, plan.subject, plan.type, plan.status, 'practice-closure');
  assert.equal(receipt.occurredAt, friday);
  const failure = recordFrom(await desk.checkpoint('friday-read'), saved.id);
  assert.equal(failure.issue, 'receipt-unavailable');
  assert.equal(failure.status, 'open');
  assert.equal(failure.receiptProof, null);
  assert.deepEqual(failure.receiptCheck, waiting.receiptCheck);
  assert.equal(failure.owner, available.owner);
  assert.equal(failure.checkDate, saved.checkDate);
  const failedReads = provider.inspect().reads;
  assert.deepEqual(failedReads.slice(1).map(({ status, issuer, subject }) => [status, issuer, subject]), [
    ['unavailable', plan.issuer, plan.subject], ['unavailable', plan.issuer, plan.subject]
  ]);
  await desk.restart(friday);
  assert.deepEqual(desk.publish('receipt-online', plan.issuer), { issuer: plan.issuer, available: true });
  assert.deepEqual(recordFrom(await desk.checkpoint('friday-read'), saved.id), failure);
  assert.deepEqual(provider.inspect().reads, failedReads);
  const recovered = recordFrom(await desk.checkpoint('manual-retry'), saved.id);
  assert.equal(recovered.status, 'verified');
  assert.equal(recovered.receiptProof.id, 'practice-closure');
  assert.deepEqual(recovered.receiptCheck, { checkedAt: friday, lastEventAt: friday });
  assert.equal(provider.inspect().reads.length, 4);
});

test('correcting a receipt preserves the original note and renews access only for a changed scope', async t => {
  const desk = await rehearsal(t);
  const provider = desk.provider(openReceiptFixture);
  const saved = await desk.save('Check on the practice membership on Friday.');
  const plan = { capability: 'receipt', ...membershipProof };
  const configured = await desk.setup(saved, plan);
  const granted = await desk.allow(configured, 'receipt');
  const checked = recordFrom(await desk.checkpoint(), saved.id);
  const revisedPlan = { ...plan, status: 'cancelled' };
  const revised = await desk.setup(checked, revisedPlan);
  assert.deepEqual(revised.grants, granted.grants);
  assert.deepEqual(revised.receiptCheck, checked.receiptCheck);
  assert.deepEqual(await desk.setup(revised, revisedPlan), revised);
  await desk.setup(checked, plan, 409);

  provider.putReceipt({ ...membershipProof, occurredAt: monday, id: 'old-proof' });
  const pending = recordFrom(await desk.checkpoint(), saved.id);
  assert.equal(pending.status, 'open');
  const newPlan = { ...revisedPlan, subject: 'membership-corrected-302' };
  const corrected = await desk.setup(pending, newPlan);
  assert.equal(corrected.receiptCheck, null);
  assert.equal(corrected.grants.receipt.status, 'withdrawn');
  assert.deepEqual(corrected.grants.receipt.scope, granted.grants.receipt.scope);
  const priorReads = provider.inspect().reads;
  await desk.restart(friday);
  const waiting = recordFrom(await desk.checkpoint(), saved.id);
  assert.equal(waiting.issue, 'receipt-permission');
  assert.deepEqual(provider.inspect().reads, priorReads);
  await desk.setup(waiting, { ...newPlan, capability: 'visit' }, 409);
  const renewed = await desk.allow(waiting, 'receipt');
  assert.equal(renewed.grants.receipt.scope.subject, newPlan.subject);
  assert.ok(renewed.grants.receipt.revision > granted.grants.receipt.revision);
  provider.putReceipt({ ...membershipProof, subject: newPlan.subject, status: 'cancelled', occurredAt: friday, id: 'corrected-proof' });
  const verified = recordFrom(await desk.checkpoint(), saved.id);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.receiptProof.id, 'corrected-proof');
  assert.equal(verified.note, saved.note);
  assert.equal(verified.checkDate, saved.checkDate);
  await desk.setup(verified, plan, 409);
});

test('R7 operator offers reach a new visit through its own booking and calendar permissions', async t => {
  const desk = await rehearsal(t);
  const provider = desk.provider(openVisitFixture);
  const note = 'Could you find a free Tuesday equipment induction at the practice tool library?';
  const scope = {
    issuer: 'practice-tool-library',
    service: 'equipment-induction',
    subject: 'seat-47',
    zone: 'Asia/Kolkata',
    windowStart: '2026-11-24T16:15:00+05:30',
    windowEnd: '2026-11-24T18:00:00+05:30'
  };
  const time = hour => `2026-11-24T${hour}:00+05:30`;
  const offer = (id, start, end, fee = '0', issuer = scope.issuer) => desk.publish('visit-slot', id, issuer, scope.service,
    scope.subject, time(start), time(end), fee);
  const commitment = desk.publish('calendar-commitment', 'practice-tool-library-commitment', time('16:25'), time('16:40'),
    'Synthetic protected commitment');
  assert.equal(commitment.protected, true);
  offer('practice-induction-outside-window', '16:00', '16:10');
  offer('practice-induction-busy', '16:25', '16:35');
  assert.equal(offer('practice-induction-paid', '16:45', '16:55', '10000').feeMinor, 10000);
  const removed = offer('practice-induction-withdrawn', '16:50', '17:00');
  const withdrawn = desk.publish('visit-slot-withdraw', removed.id);
  assert.deepEqual(withdrawn, { ...removed, active: false, revision: removed.revision + 1 });
  assert.deepEqual(desk.publish('visit-slot-withdraw', removed.id), withdrawn);
  offer('practice-induction-other-provider', '16:15', '16:25', '0', 'another-practice-library');
  assert.deepEqual(provider.inspect().attempts, []);
  assert.deepEqual(provider.inspect().reads, []);

  const saved = await desk.save(note);
  const configured = await desk.setup(saved, { capability: 'visit', ...scope });
  assert.deepEqual(configured.visit, scope);
  assert.equal(configured.note, note);
  assert.equal(configured.owner, scope.issuer);
  assert.deepEqual(configured.grants ?? {}, {});

  const first = await desk.checkpoint();
  assert.equal(recordFrom(first, 'demo-visit').status, 'verified');
  let orientation = recordFrom(first, saved.id);
  assert.equal(orientation.status, 'open');
  assert.equal(orientation.issue, 'visit-permission');
  const initial = provider.inspect();
  assert.deepEqual(initial.reservations.map(({ issuer, service, subject }) => ({ issuer, service, subject })), [{
    issuer: mondayVisit.issuer, service: mondayVisit.service, subject: mondayVisit.subject
  }]);
  assert.deepEqual(initial.attempts.map(attempt => attempt.operation), ['reserve', 'calendar.add']);
  assert.ok(!initial.reads.some(read => read.scope.issuer === scope.issuer));

  for (const operation of ['freeBusy', 'slots', 'reserve']) {
    orientation = await desk.allow(orientation, operation);
    assert.deepEqual(orientation.grants[operation].scope, scope);
  }
  const noSafeOffer = recordFrom(await desk.checkpoint(), saved.id);
  assert.equal(noSafeOffer.status, 'open');
  assert.equal(noSafeOffer.issue, 'slot-unavailable');
  assert.deepEqual(provider.inspect().reservations, initial.reservations);
  assert.deepEqual(provider.inspect().attempts, initial.attempts);
  assert.ok(!provider.inspect().reads.some(read => read.scope.issuer === 'another-practice-library'));

  const slot = offer('practice-induction-free', '17:00', '17:30');
  assert.deepEqual(offer(slot.id, '17:00', '17:30'), slot);
  assert.deepEqual(provider.inspect().slots.find(candidate => candidate.id === slot.id), slot);
  const booked = recordFrom(await desk.checkpoint(), saved.id);
  assert.equal(booked.status, 'booked');
  assert.equal(booked.issue, 'calendar-pending');
  assert.equal(booked.calendarEvent, null);
  const reservation = booked.reservation;
  assert.equal(reservation.issuer, scope.issuer);
  assert.equal(reservation.service, scope.service);
  assert.equal(reservation.subject, scope.subject);
  assert.equal(reservation.slotId, slot.id);
  assert.equal(reservation.start, slot.start);
  assert.equal(reservation.end, slot.end);
  assert.equal(reservation.feeMinor, 0);
  const beforeCalendar = provider.inspect();
  assert.deepEqual(beforeCalendar.reservations, [...initial.reservations, reservation]);
  assert.deepEqual(beforeCalendar.calendar, initial.calendar);
  assert.ok(!beforeCalendar.reads.some(read => read.source === 'calendar' && read.scope.reservationId === reservation.id));

  await desk.allow(booked, 'calendar');
  const completed = recordFrom(await desk.checkpoint(), saved.id);
  assert.equal(completed.status, 'verified');
  assert.deepEqual(completed.reservation, reservation);
  const native = provider.inspect();
  assert.deepEqual(native.reservations, beforeCalendar.reservations);
  assert.equal(native.calendar.length, initial.calendar.length + 1);
  const nativeEvent = native.calendar.find(event => event.reservationId === reservation.id);
  assert.ok(nativeEvent);
  assert.equal(nativeEvent.id, completed.calendarEvent.id);
  assert.equal(nativeEvent.start, slot.start);
  assert.equal(nativeEvent.end, slot.end);
  assert.deepEqual(native.calendar.filter(event => event.id !== nativeEvent.id), initial.calendar);
  assert.deepEqual(native.calendar.find(event => event.id === commitment.id), commitment);
});

test('correcting an unattempted visit keeps the note and withdraws access to the old terms', async t => {
  const desk = await rehearsal(t);
  const provider = desk.provider(openVisitFixture);
  const scope = {
    issuer: 'practice-bicycle-works', service: 'dropoff', subject: 'ticket-typo',
    windowStart: '2026-11-24T16:15:00+05:30', windowEnd: '2026-11-24T18:00:00+05:30'
  };
  const plan = { capability: 'visit', ...scope };
  const seeded = recordFrom(await desk.brief(), 'demo-visit');
  assert.equal(seeded.visitPlanEditable, undefined);
  await desk.setup(seeded, plan, 409);

  const note = 'Could you find a free drop-off at Bicycle Works? Can you help me check on Friday?';
  const saved = await desk.save(note);
  let configured = await desk.setup(saved, { ...plan, owner: 'Practice Bicycle Works' });
  assert.equal(configured.visitPlanEditable, true);
  for (const operation of ['freeBusy', 'slots', 'reserve', 'calendar']) {
    configured = await desk.allow(configured, operation);
    assert.equal(configured.visitPlanEditable, true);
  }
  const waiting = recordFrom(await desk.checkpoint(), saved.id);
  assert.equal(waiting.issue, 'slot-unavailable');
  assert.equal(waiting.visitPlanEditable, true);
  const before = provider.inspect();
  const sameWindow = { ...plan, windowStart: '2026-11-24T10:45:00.000Z', windowEnd: '2026-11-24T18:00:00.000+05:30' };
  assert.deepEqual(await desk.setup(waiting, sameWindow), waiting);
  assert.deepEqual(provider.inspect(), before);

  const newTerms = { ...plan, subject: 'ticket-72', windowStart: '2026-11-24T16:30:00+05:30' };
  const corrected = await desk.setup(waiting, newTerms);
  assert.equal(corrected.revision, waiting.revision + 1);
  assert.equal(corrected.visitPlanEditable, true);
  assert.equal(corrected.owner, 'Practice Bicycle Works');
  assert.equal(corrected.issue, 'visit-permission');
  assert.equal(corrected.note, note);
  assert.equal(corrected.goal, saved.goal);
  assert.equal(corrected.checkDate, saved.checkDate);
  assert.equal(corrected.visit.subject, newTerms.subject);
  assert.equal(corrected.visit.windowStart, newTerms.windowStart);
  for (const [operation, oldGrant] of Object.entries(waiting.grants)) {
    assert.deepEqual(corrected.grants[operation], { ...oldGrant, status: 'withdrawn', revision: oldGrant.revision + 1, expiresAt: null });
  }
  await desk.setup(waiting, plan, 409);
  await desk.setup(corrected, { capability: 'receipt', ...membershipProof }, 409);
  assert.deepEqual(provider.inspect(), before);

  await desk.restart(monday);
  const reopened = recordFrom(await desk.brief(), saved.id);
  assert.deepEqual(reopened, corrected);
  const regranted = await desk.allow(reopened, 'slots');
  assert.deepEqual(regranted.grants.slots.scope, corrected.visit);
  assert.equal(regranted.grants.slots.revision, corrected.grants.slots.revision + 1);
});

test('an agreed visit cannot be changed once an original booking intent exists', async t => {
  const desk = await rehearsal(t);
  const provider = desk.provider(openVisitFixture);
  const plan = {
    capability: 'visit', issuer: 'practice-observatory', service: 'orientation', subject: 'seat-12',
    windowStart: '2026-11-24T16:15:00+05:30', windowEnd: '2026-11-24T18:00:00+05:30'
  };
  const saved = await desk.save('Could you book a free orientation at the practice observatory?');
  const configured = await desk.setup(saved, plan);
  const database = desk.provider(({ dataDir }) => new DatabaseSync(join(dataDir, 'desk.sqlite')));
  const journal = openActionJournal(database, () => configured, action => action(), () => new Date(monday));
  const key = `visit:${saved.id}:reserve:observatory-offer:1`;
  journal.prepare(saved.id, 'reserve', key, { ...configured.visit, key });
  const pending = recordFrom(await desk.brief(), saved.id);
  assert.equal(pending.status, 'open');
  assert.equal(pending.visitPlanEditable, false);
  await desk.setup(pending, { ...plan, subject: 'seat-13' }, 409);
  journal.mark(key, 'blocked');
  await desk.setup(pending, { ...plan, subject: 'seat-13' }, 409);
  assert.equal(journal.latest(saved.id, 'reserve').status, 'blocked');
  assert.deepEqual(provider.inspect().attempts, []);
  assert.deepEqual(provider.inspect().reads, []);
  assert.deepEqual(recordFrom(await desk.brief(), saved.id), pending);
});

test('an ambiguous confirmation keeps the same native booking and rejects scope changes', async t => {
  const desk = await rehearsal(t);
  const provider = desk.provider(openVisitFixture);
  const plan = {
    capability: 'visit', issuer: 'practice-rocketry-club', service: 'safety-demo', subject: 'seat-15',
    windowStart: '2026-11-24T16:15:00+05:30', windowEnd: '2026-11-24T18:00:00+05:30'
  };
  const saved = await desk.save('Find a free place in the practice rocketry club demonstration.');
  await desk.setup(saved, plan);
  let agreed = recordFrom(await desk.checkpoint('book-seeded-visit'), saved.id);
  for (const operation of ['freeBusy', 'slots', 'reserve', 'calendar']) agreed = await desk.allow(agreed, operation);
  const selected = desk.publish('visit-slot', 'practice-safety-demo-free', plan.issuer, plan.service, plan.subject,
    '2026-11-24T17:00:00+05:30', '2026-11-24T17:30:00+05:30', '0');
  provider.failNextReservationReply();
  const pending = recordFrom(await desk.checkpoint('lost-reply'), saved.id);
  assert.equal(pending.status, 'open');
  assert.equal(pending.issue, 'reservation-unknown');
  assert.equal(pending.visitPlanEditable, false);
  const native = provider.inspect();
  const booking = native.reservations.find(reservation => reservation.slotId === selected.id);
  assert.ok(booking);
  await desk.setup(pending, { ...plan, windowEnd: '2026-11-24T17:45:00+05:30' }, 409);
  assert.deepEqual(provider.inspect(), native);

  await desk.restart(monday);
  const recovered = recordFrom(await desk.checkpoint('recover-original'), saved.id);
  assert.equal(recovered.status, 'verified');
  assert.equal(recovered.visitPlanEditable, false);
  assert.deepEqual(recovered.reservation, booking);
  assert.equal(recovered.calendarEvent.reservationId, booking.id);
  await desk.setup(recovered, plan, 409);
  assert.deepEqual(provider.inspect().reservations, native.reservations);
});
