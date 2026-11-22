import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { constants } from 'node:os';
import { join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rubricPath = 'docs/evaluation.md';

function sourcePaths(directory, matches) {
  return readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && matches.test(entry.name))
    .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

function fingerprint(paths) {
  const files = [...paths].sort();
  const hash = createHash('sha256');
  for (const path of files) {
    const bytes = readFileSync(join(root, path));
    hash.update(JSON.stringify([path, bytes.length]) + '\n');
    hash.update(bytes);
  }
  return { files, sha256: hash.digest('hex') };
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const gitRevision = git(['rev-parse', 'HEAD']);
const workingTree = gitRevision ? git(['status', '--porcelain=v1']) : null;

console.log(JSON.stringify({
  event: 'evaluation-start',
  evaluation: 'scripted-rehearsal',
  mode: 'fixed-rule',
  nodeVersion: process.version,
  gitRevision,
  ...(workingTree !== null ? { gitDirty: workingTree.length > 0 } : {}),
  fixtures: fingerprint([...sourcePaths('src', /-fixture\.mjs$/u), 'src/household.mjs']),
  testSources: fingerprint(sourcePaths('test', /\.[cm]?js$/u)),
  rubric: {
    path: rubricPath,
    sha256: createHash('sha256').update(readFileSync(join(root, rubricPath))).digest('hex')
  }
}));

const start = performance.now();
const result = spawnSync(process.execPath, ['--test'], { cwd: root, stdio: 'inherit' });
console.log(JSON.stringify({
  event: 'evaluation-finish',
  durationMs: Math.round(performance.now() - start),
  status: result.status,
  ...(result.signal ? { signal: result.signal } : {}),
  ...(result.error ? { error: result.error.message } : {})
}));

process.exitCode = result.status ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 1) : 1);
