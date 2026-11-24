import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDesk } from '../src/desk.mjs';
import { openRefundFixture } from '../src/refund-fixture.mjs';
import { openVisitFixture } from '../src/visit-fixture.mjs';

const time = '2026-11-23T09:00:00+05:30';
const clock = () => new Date(time);
const resetPaused = 'Previous provider resets committed';
const pauseBetweenStores = `import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (sql.startsWith('DELETE FROM outbox_messages')) {
    writeSync(1, ${JSON.stringify(`${resetPaused}\n`)});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return exec.call(this, sql);
};`;
const preload = `data:text/javascript,${encodeURIComponent(pauseBetweenStores)}`;
const addressPattern = /http:\/\/127\.0\.0\.1:\d+/u;

function start(dataDir, args, pause = false) {
  const child = spawn(process.execPath, [...(pause ? ['--import', preload] : []), 'src/server.mjs', ...args], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, RELAY_CLOCK: time, RELAY_PORT: '0', RELAY_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  async function output(pattern) {
    const signal = AbortSignal.timeout(5000);
    while (!pattern.test(stdout)) {
      const next = await Promise.race([once(child.stdout, 'data', { signal }), closed]);
      assert.equal(typeof next[0], 'string', `CLI exited before ${pattern}. ${stderr}`);
    }
    return stdout.match(pattern)[0];
  }
  return {
    output,
    url: () => output(addressPattern),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  };
}

async function request(url, pathname, { method = 'GET', context, body, status = 200 } = {}) {
  const response = await fetch(url + pathname, {
    method, signal: AbortSignal.timeout(5000),
    headers: {
      ...(context === undefined ? {} : { 'X-Relay-Desk': context }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  assert.equal(response.status, status, `${method} ${pathname}: ${JSON.stringify(result)}`);
  return result;
}

test('an interrupted CLI reset gates practice across a restart and leaves private notes and drafts available', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-cli-practice-reset-'));
  const children = [];
  const invoke = (args, pause) => {
    const child = start(dataDir, args, pause);
    children.push(child);
    return child;
  };
  const resetArgs = ['--fixture', '--reset'];
  const recovering = { status: 503 };
  const code = 'practice-reset-incomplete';
  try {
    const privateProcess = invoke([]);
    const personal = await privateProcess.url();
    const { deskContext: privateContext } = await request(personal, '/api/desk');
    const note = 'Synthetic private note to keep while the practice household resets.';
    const errand = await request(personal, '/api/errands', { method: 'POST', status: 201, context: privateContext, body: { note } });
    const draftPath = `/api/errands/${errand.id}`;
    const saved = await request(personal, `${draftPath}/local-draft`, {
      method: 'PUT', context: privateContext, body: { text: 'Existing private words.', draftRevision: 0 }
    });

    const practice = await invoke(resetArgs).url();
    const { deskContext: originalContext } = await request(practice, '/api/desk');
    await request(practice, '/api/errands', {
      method: 'POST', context: originalContext, status: 201, body: { note: 'Synthetic practice note.' }
    });
    const checked = await request(practice, '/api/checkpoint', { method: 'POST', context: originalContext, body: { checkpointId: 'before-crash' } });
    const verify = checked.errands.find(row => row.id === 'demo-visit');
    assert.equal(verify.status, 'verified');
    const originalVisit = await request(practice, '/api/fixture/visit', { context: originalContext });
    assert.equal(originalVisit.reservations[0].id, verify.reservation.id);
    assert.equal(originalVisit.calendar.find(event => event.reservationId)?.id, verify.calendarEvent.id);

    const reset = invoke([...resetArgs, '--cold'], true);
    await reset.output(new RegExp(resetPaused, 'u'));
    const provider = openVisitFixture({ dataDir, clock });
    try {
      const partial = provider.inspect();
      assert.deepEqual(partial.reservations, []);
      assert.deepEqual(partial.calendar, originalVisit.calendar.filter(event => !event.reservationId));
    } finally {
      provider.close();
    }
    const unavailable = await request(practice, '/api/desk', recovering);
    assert.equal(unavailable.code, code);
    assert.match(unavailable.error, /npm run reset/u);
    assert.equal((await request(practice, '/api/inspect', { ...recovering, context: originalContext })).code, code);
    assert.equal((await request(practice, '/api/fixture/visit', { ...recovering, context: originalContext })).code, code);
    assert.equal((await request(practice, '/api/checkpoint', {
      ...recovering, method: 'POST', context: originalContext, body: {}
    })).code, code);
    await reset.stop();
    assert.equal((await request(practice, '/api/desk', { ...recovering, context: originalContext })).code, code);
    const restarted = await invoke(['--fixture']).url();
    assert.equal((await request(restarted, '/api/desk', recovering)).code, code);

    await privateProcess.stop();
    const reopenedPersonal = await invoke([]).url();
    const privateBrief = await request(reopenedPersonal, '/api/desk', { context: privateContext });
    assert.equal(privateBrief.deskContext, privateContext);
    assert.deepEqual(privateBrief.errands, [errand]);
    assert.deepEqual(await request(reopenedPersonal, `${draftPath}/draft`, { method: 'POST', context: privateContext }), saved);
    const updated = await request(reopenedPersonal, `${draftPath}/local-draft`, {
      method: 'PUT', context: privateContext, body: { text: 'Updated private words.', draftRevision: saved.draftRevision }
    });

    const refund = openRefundFixture({ dataDir, clock });
    const narrower = openDesk({ dataDir, clock, refundFixture: refund });
    try {
      assert.throws(() => narrower.resetPractice(false, refund.reset), { code });
    } finally {
      narrower.close();
      refund.close();
    }

    const recovered = await invoke([...resetArgs, '--cold']).url();
    const after = await request(recovered, '/api/desk');
    assert.notEqual(after.deskContext, originalContext);
    assert.deepEqual(after.errands.map(row => row.id).sort(), ['demo-bill', 'demo-refund', 'demo-visit']);
    assert.ok(after.errands.every(row => row.status === 'open' && !Object.keys(row.grants ?? row.refundAccess).length));
    assert.equal((await request(practice, '/api/desk', { context: originalContext, status: 409 })).code, 'desk-context-changed');
    assert.equal((await request(restarted, '/api/desk')).deskContext, after.deskContext);
    assert.deepEqual((await request(recovered, '/api/inspect')).actions, []);
    assert.deepEqual((await request(recovered, '/api/fixture/visit')).reservations, []);
    assert.deepEqual((await request(recovered, '/api/fixture/refund')).reads, []);
    assert.deepEqual(await request(reopenedPersonal, `${draftPath}/draft`, { method: 'POST', context: privateContext }), updated);
  } finally {
    await Promise.all(children.map(child => child.stop()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
