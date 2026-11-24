import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const pinnedSpecification = 'e7b729d64489d5622118d55c8d9664f35bf3a9f0';

export function gradeCheckpoint({ label, expected, observed, required, ...inputs }) {
  if (!expected || !required.every(key => Object.hasOwn(expected, key)) ||
      !Object.keys(expected).every(key => Object.hasOwn(observed, key))) {
    throw new TypeError(`Invalid expected evidence at ${label}.`);
  }
  const mismatches = Object.keys(expected).filter(key => !isDeepStrictEqual(observed[key], expected[key]));
  return { label, ...inputs, expected, observed, mismatches, passed: mismatches.length === 0 };
}

export function writeReplayReport(mode, raw, scenarios, details = {}) {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true
  });
  const passed = scenarios.every(scenario => scenario.passed);
  process.stdout.write(`${JSON.stringify({
    mode, pinnedSpecification, repositoryRevision: git.status === 0 ? git.stdout.trim() : null,
    ...details, fixtureSha256: createHash('sha256').update(raw).digest('hex'), scenarios, passed
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}
