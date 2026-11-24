import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { promisify } from 'node:util';

const cwd = new URL('../', import.meta.url);
const run = promisify(execFile);
const serverArgs = ['src/server.mjs', '--fixture', '--reset'];
const publishArgs = ['scripts/demo-evidence.mjs', 'matching-credit'];

async function dataDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-cli-clock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'practice');
}

test('the server and operator CLIs reject ambiguous and impossible clocks before writing', async t => {
  const dataDir = await dataDirectory(t);
  for (const value of ['', '2026-11-23', '2026-11-23T09:00:00', '2026-11-31T09:00:00+05:30']) {
    const env = { ...process.env, RELAY_CLOCK: value, RELAY_PORT: '0', RELAY_DATA_DIR: dataDir };
    for (const args of [serverArgs, publishArgs]) {
      await assert.rejects(run(process.execPath, args, { cwd, env, timeout: 5000 }), error => {
        assert.equal(error.code, 1, `${args[0]} with clock ${JSON.stringify(value)}`);
        assert.match(error.stderr, /RELAY_CLOCK.*valid ISO timestamp with an explicit offset/);
        return true;
      });
    }
  }
  assert.equal(existsSync(dataDir), false);
});

test('the CLI clock and operator evidence agree on the instant across offsets', async t => {
  const dataDir = await dataDirectory(t);
  const env = { ...process.env, RELAY_CLOCK: '2026-11-23T09:15+05:45', RELAY_PORT: '0', RELAY_DATA_DIR: dataDir };
  const server = spawn(process.execPath, serverArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(server, 'close');
  const lines = createInterface({ input: server.stdout });
  let stderr = '';
  server.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const [line] = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(5000) }),
      closed.then(([code]) => assert.fail(`The server exited with code ${code}. ${stderr}`))
    ]);
    const address = /http:\/\/127\.0\.0\.1:\d+/.exec(line)?.[0];
    assert.ok(address, line);
    const url = new URL('/api/desk', address);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const brief = await response.json();
    assert.equal(brief.now, '2026-11-23T03:30:00.000Z');

    const { stdout } = await run(process.execPath, publishArgs, {
      cwd, env: { ...env, RELAY_CLOCK: '2026-11-23T03:30Z' }, timeout: 5000
    });
    assert.equal(JSON.parse(stdout).postedAt, brief.now);
    const native = await fetch(new URL('/api/fixture/refund', address), { signal: AbortSignal.timeout(5000) });
    assert.equal(native.status, 200);
    assert.ok((await native.json()).credits.some(row => row.postedAt === brief.now && row.id === 'demo-posted-refund'));
  } finally {
    lines.close();
    if (server.exitCode === null) server.kill();
    await closed;
  }
});
