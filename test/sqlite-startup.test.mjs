import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const observeBusy = `import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  try {
    return exec.call(this, sql);
  } catch (error) {
    if ((error.errcode & 0xff) === 5 && sql.includes('journal_mode = WAL')) writeSync(1, 'WAL lock observed\\n');
    throw error;
  }
};`;

function start(dataDir) {
  const preload = `data:text/javascript,${encodeURIComponent(observeBusy)}`;
  const child = spawn(process.execPath, ['--import', preload, 'src/server.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, RELAY_DATA_DIR: dataDir, RELAY_PORT: '0', RELAY_CLOCK: '2026-11-23T09:00:00+05:30' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  return {
    async output(pattern) {
      const signal = AbortSignal.timeout(5000);
      while (!pattern.test(stdout)) {
        const [result] = await Promise.race([once(child.stdout, 'data', { signal }), closed]);
        assert.equal(typeof result, 'string', `The desk exited before startup. ${stderr}`);
      }
      return stdout.match(pattern)[0];
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  };
}

test('independent desks wait for WAL initialization and keep records in the old SQLite file', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-sqlite-startup-'));
  const filename = join(dataDir, 'desk.sqlite');
  let holder = new DatabaseSync(filename);
  const desks = [];
  const existing = {
    id: 'old-private-errand', revision: 1, note: 'Keep the original synthetic note.',
    kind: 'errand', goal: 'Ask for the original receipt', checkDate: '2026-11-27', status: 'open'
  };
  try {
    holder.exec('PRAGMA journal_mode = DELETE; CREATE TABLE errands (id TEXT PRIMARY KEY, revision INTEGER, record TEXT) STRICT;');
    holder.prepare('INSERT INTO errands VALUES (?, ?, ?)').run(existing.id, existing.revision, JSON.stringify(existing));
    holder.exec('BEGIN IMMEDIATE');
    desks.push(start(dataDir), start(dataDir));
    await Promise.all(desks.map(desk => desk.output(/WAL lock observed/u)));
    holder.exec('COMMIT');
    holder.close();
    holder = null;

    const briefs = await Promise.all(desks.map(async desk => {
      const url = await desk.output(/http:\/\/127\.0\.0\.1:\d+/u);
      const response = await fetch(url + '/api/desk', { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      return response.json();
    }));
    assert.equal(briefs[0].deskContext, briefs[1].deskContext);
    assert.ok(briefs[0].deskContext);
    for (const brief of briefs) assert.deepEqual(brief.errands, [existing]);
    const readback = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(readback.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    } finally {
      readback.close();
    }
  } finally {
    holder?.close();
    await Promise.all(desks.map(desk => desk.stop()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
