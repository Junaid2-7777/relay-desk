import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDesk } from '../src/desk.mjs';
import { openOutboxFixture } from '../src/outbox-fixture.mjs';
import { openRefundFixture } from '../src/refund-fixture.mjs';

const queuedAt = '2026-11-27T07:00:00.000Z';
const retriedAt = '2026-11-27T08:00:00.000Z';
const draft = {
  key: 'return-1249-follow-up', recipient: 'shop@example.invalid', subject: 'Refund for return 1249',
  text: 'Hello, could you share an update on the refund?\nThank you.'
};

test('queues only the exact approved draft and preserves the original across reopens', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-outbox-'));
  t.after(() => rmSync(dataDir, { force: true, recursive: true }));
  const first = openOutboxFixture({ dataDir, clock: () => new Date(queuedAt) });
  let created;
  try {
    const authorizationError = new Error('Approval lookup failed.');
    assert.throws(() => first.enqueue({ ...draft, text: '' }, () => true), { code: 'invalid-message' });
    assert.throws(() => first.enqueue(draft, () => false), { code: 'not-authorized' });
    assert.throws(() => first.enqueue(draft), { code: 'not-authorized' });
    assert.throws(() => first.enqueue(draft, () => { throw authorizationError; }), error => error === authorizationError);
    assert.equal(first.get(draft.key), null);
    assert.deepEqual(first.inspect().messages, []);

    created = first.enqueue(draft, exact => {
      assert.deepEqual(exact, draft);
      assert.ok(Object.isFrozen(exact));
      return true;
    });
    assert.deepEqual(created, { ...draft, status: 'queued', queuedAt });
  } finally {
    first.close();
  }

  const reopened = openOutboxFixture({ dataDir, clock: () => new Date(retriedAt) });
  try {
    assert.deepEqual(reopened.get(draft.key), created);
    assert.deepEqual(reopened.enqueue(draft, () => assert.fail('retry must not create a new row')), created);
    assert.throws(() => reopened.enqueue({ ...draft, text: `${draft.text} ` }, () => true), { code: 'operation-mismatch' });
    assert.deepEqual(reopened.inspect().messages, [created]);
    assert.deepEqual(reopened.inspect().attempts, [
      { key: draft.key, status: 'blocked', code: 'not-authorized', attemptedAt: queuedAt },
      { key: draft.key, status: 'blocked', code: 'not-authorized', attemptedAt: queuedAt },
      { key: draft.key, status: 'blocked', code: 'authorization-error', attemptedAt: queuedAt },
      { key: draft.key, status: 'committed', code: null, attemptedAt: queuedAt },
      { key: draft.key, status: 'recovered', code: null, attemptedAt: retriedAt },
      { key: draft.key, status: 'blocked', code: 'operation-mismatch', attemptedAt: retriedAt }
    ]);
    reopened.reset();
    assert.deepEqual(reopened.inspect(), { messages: [], attempts: [] });
  } finally {
    reopened.close();
  }
});

test('a read-only recheck of a missing native row retires the pending draft without enqueueing', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-outbox-absence-'));
  const clock = () => new Date(queuedAt);
  const native = openOutboxFixture({ dataDir, clock });
  const refundFixture = openRefundFixture({ dataDir, clock });
  let responded = false;
  const outbox = {
    ...native,
    enqueue(...args) {
      if (responded) return native.enqueue(...args);
      responded = true;
      return undefined;
    }
  };
  const household = { outbox: { fixture: outbox }, receipt: { fixture: { sources: () => [] } } };
  const desk = openDesk({ dataDir, clock, refundFixture, household });
  t.after(() => {
    desk.close();
    refundFixture.close();
    native.close();
    rmSync(dataDir, { force: true, recursive: true });
  });

  const { id, revision } = desk.resetRefund();
  const terms = { ...desk.draft(id), revision, text: 'Please share the original confirmation.' };
  assert.throws(() => desk.queueFollowup(id, terms), { status: 409 });
  assert.equal(desk.brief().errands[0].pendingFollowup, true);
  assert.equal(desk.draft(id).text, terms.text);
  assert.deepEqual(native.inspect(), { messages: [], attempts: [] });

  const reconciled = desk.queueFollowup(id, { ...terms, reconcileOnly: true });
  assert.equal(reconciled.revision, revision);
  assert.equal(reconciled.pendingFollowup, false);
  assert.equal(reconciled.followupReconciliation, 'not-queued');
  assert.equal(desk.brief().errands[0].pendingFollowup, undefined);
  assert.deepEqual(native.inspect(), { messages: [], attempts: [] });

  const saved = desk.queueFollowup(id, { ...terms, text: 'An explicitly approved new draft.' });
  assert.equal(saved.queuedFollowup.text, 'An explicitly approved new draft.');
  assert.deepEqual(native.inspect().messages, [saved.queuedFollowup]);
});
