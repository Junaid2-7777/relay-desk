import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
    setup: (errand, params) => request(`/api/errands/${errand.id}/setup`, { revision: errand.revision, ...params }),
    allow: (errand, operation) => request(`/api/errands/${errand.id}/household-access`, {
      revision: errand.revision, operation, choice: 'allowed'
    }),
    checkpoint: () => request('/api/checkpoint', {}),
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

test('R7 rehearsal books a new free seat only under its own provider, service and subject grants', async t => {
  const desk = await rehearsal(t);
  const provider = desk.provider(openVisitFixture);
  const note = 'Book a free Tuesday orientation seat at my community centre.';
  const scope = {
    issuer: 'practice-community-centre',
    service: 'member-orientation',
    subject: 'household-orientation-seat',
    zone: 'Asia/Kolkata',
    windowStart: '2026-11-24T16:15:00+05:30',
    windowEnd: '2026-11-24T18:00:00+05:30'
  };
  const slot = provider.putSlot({
    id: 'rehearsal-new-orientation-slot',
    issuer: scope.issuer,
    service: scope.service,
    subject: scope.subject,
    zone: scope.zone,
    start: '2026-11-24T17:00:00+05:30',
    end: '2026-11-24T17:30:00+05:30'
  });
  const saved = await desk.save(note);
  const configured = await desk.setup(saved, { capability: 'visit', owner: 'Practice community centre', ...scope });
  assert.deepEqual(configured.visit, scope);
  assert.equal(configured.note, note);
  assert.equal(configured.owner, 'Practice community centre');
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

  for (const operation of ['freeBusy', 'slots', 'calendar', 'reserve']) {
    orientation = await desk.allow(orientation, operation);
    assert.deepEqual(orientation.grants[operation].scope, scope);
  }

  const completed = recordFrom(await desk.checkpoint(), saved.id);
  assert.equal(completed.status, 'verified');
  const native = provider.inspect();
  assert.equal(native.reservations.length, 2);
  assert.equal(native.calendar.length, initial.calendar.length + 1);
  assert.deepEqual(native.reservations.filter(reservation => reservation.subject === scope.subject), [completed.reservation]);
  const reservation = completed.reservation;
  assert.equal(reservation.issuer, scope.issuer);
  assert.equal(reservation.service, scope.service);
  assert.equal(reservation.slotId, slot.id);
  assert.equal(reservation.start, slot.start);
  assert.equal(reservation.end, slot.end);
  assert.equal(reservation.feeMinor, 0);
  const nativeEvent = native.calendar.find(event => event.reservationId === reservation.id);
  assert.ok(nativeEvent);
  assert.equal(nativeEvent.id, completed.calendarEvent.id);
  assert.equal(nativeEvent.start, slot.start);
  assert.equal(nativeEvent.end, slot.end);
  assert.deepEqual(native.calendar.filter(event => event.id !== nativeEvent.id), initial.calendar);
});
