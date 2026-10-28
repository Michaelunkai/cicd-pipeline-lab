/**
 * engine.test.mjs — the engine tests itself (a CI pipeline should always be
 * under test like the code it ships). Pure-function unit tests for the DAG,
 * masking, artifact matching and ZIP layer; spawned-process integration tests
 * for lint, scan, dry-run planning, and one full pipeline run.
 *
 * Fixture secrets are assembled at runtime so this file contains no
 * credential-shaped literals (it is itself inside the scanner's sweep).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { topoSort, planRun, maskSecrets, matchPath, newRunId, skippedBecause } from '../pipeline.mjs';
import { crc32, zipFiles, unzip, extract } from '../tools/zip.mjs';
import { appendHistory, rollbackEnv, writeJson } from '../tools/deploy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGES = [
  { id: 'lint', name: 'Lint', needs: [] },
  { id: 'test', name: 'Unit tests', needs: [] },
  { id: 'build', name: 'Build', needs: ['lint', 'test'] },
  { id: 'package', name: 'Package', needs: ['build'] },
  { id: 'deploy', name: 'Deploy', needs: ['package'], approval: true },
];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

// ── DAG / planning ──────────────────────────────────────────────────────────

test('topoSort puts every need before its dependent', () => {
  const order = topoSort(STAGES);
  for (const s of STAGES) for (const need of s.needs) assert.ok(order.indexOf(need) < order.indexOf(s.id), `${need} must precede ${s.id}`);
});

test('topoSort rejects a dependency cycle', () => {
  assert.throws(() => topoSort([{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }]), /cycle/);
});

test('topoSort rejects an unknown need', () => {
  assert.throws(() => topoSort([{ id: 'a', needs: ['ghost'] }]), /unknown/);
});

test('planRun with no selection plans every stage', () => {
  assert.equal(planRun(STAGES, []).length, STAGES.length);
});

test('planRun pulls transitive needs for a selected stage', () => {
  const plan = planRun(STAGES, ['deploy']);
  assert.deepEqual(plan, ['lint', 'test', 'build', 'package', 'deploy']);
});

test('planRun rejects an unknown stage id', () => {
  assert.throws(() => planRun(STAGES, ['nope']), /unknown stage/);
});

test('skippedBecause explains why a dependent stage cannot run', () => {
  const statuses = new Map([['package', 'failed']]);
  const reason = skippedBecause(statuses, [STAGES[4]]).get('deploy');
  assert.match(reason, /need "package" did not succeed \(failed\)/);
});

// ── masking / ids / artifact patterns ───────────────────────────────────────

test('maskSecrets replaces each secret value everywhere it appears', () => {
  const masked = maskSecrets('auth as sk-live-abcdef123456 then sk-live-abcdef123456 again', ['sk-live-abcdef123456']);
  assert.ok(!masked.includes('sk-live-abcdef123456'));
  assert.equal((masked.match(/\*\*\*/g) ?? []).length, 2);
});

test('maskSecrets ignores values too short to be meaningful', () => {
  assert.equal(maskSecrets('abc def', ['abc']), 'abc def');
});

test('newRunId is unique and shaped run-YYYYMMDD-HHMMSS-xxxx', () => {
  assert.match(newRunId(), /^run-\d{8}-\d{6}-[a-z0-9]{4}$/);
  assert.notEqual(newRunId(), newRunId());
});

test('matchPath handles dir/, dir/**, *.ext and exact forms', () => {
  assert.ok(matchPath('dist/taskflow.mjs', 'dist/'));
  assert.ok(matchPath('dist/sub/x.json', 'dist/**'));
  assert.ok(matchPath('artifacts/taskflow-1.0.0.zip', 'artifacts/*.zip'));
  assert.ok(matchPath('dist/manifest.json', 'dist/manifest.json'));
  assert.ok(!matchPath('dist/taskflow.mjs', 'artifacts/'));
});

// ── ZIP artifact layer ──────────────────────────────────────────────────────

test('crc32 matches the canonical check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('ZIP roundtrip preserves names, bytes and CRC integrity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-zip-'));
  const zip = path.join(dir, 'bundle.zip');
  zipFiles([
    { name: 'taskflow.mjs', data: Buffer.from('export const x = 1;\n') },
    { name: 'manifest.json', data: Buffer.from('{"version":"9.9.9"}') },
  ], zip);
  const entries = unzip(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'taskflow.mjs');
  assert.equal(JSON.parse(entries[1].data.toString()).version, '9.9.9');
});

test('unzip rejects a corrupted artifact (CRC mismatch)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-corrupt-'));
  const zip = path.join(dir, 'broken.zip');
  zipFiles([{ name: 'a.txt', data: Buffer.from('integrity matters') }], zip);
  const buf = fs.readFileSync(zip);
  buf.write('X', 30 + 'a.txt'.length + 2); // flip a byte inside the stored entry DATA
  fs.writeFileSync(zip, buf);
  assert.throws(() => unzip(zip), /CRC mismatch/);
});

test('extract writes files and strips path-escape attempts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-extract-'));
  const zip = path.join(dir, 'e.zip');
  zipFiles([{ name: '../evil.txt', data: Buffer.from('no escape') }], zip);
  const written = extract(zip, path.join(dir, 'out'));
  assert.equal(written.length, 1);
  assert.ok(written[0].startsWith(path.join(dir, 'out')));
});

// ── lint stage (spawned against fixtures) ───────────────────────────────────

test('lint fails on a violation and reports file:line:rule', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-lint-bad-'));
  fs.mkdirSync(path.join(dir, 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'src', 'bad.js'), 'const x = 1;\t\nconsole.log(x);\n');
  const r = run('node', [path.join(ROOT, 'tools', 'lint.mjs')], { cwd: dir });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /bad\.js:1:no-tabs/);
  assert.match(r.stderr, /bad\.js:2:no-console-log/);
});

test('lint passes on clean code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-lint-good-'));
  fs.mkdirSync(path.join(dir, 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'src', 'good.js'), 'const answer = 42;\n');
  const r = run('node', [path.join(ROOT, 'tools', 'lint.mjs')], { cwd: dir });
  assert.equal(r.status, 0);
});

// ── scan stage (spawned against a runtime-built leaky fixture) ─────────────

test('scan blocks credential-shaped strings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-scan-'));
  const awsId = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const ghPat = 'gh' + 'p_' + 'A1b2c3d4e5f6g7h8i9j0k1l2m3';
  const assigned = 'const api' + 'Key = "hunter2-hunter2-hunter2";';
  fs.writeFileSync(path.join(dir, 'leak.js'), `const a = "${awsId}";\nconst b = "${ghPat}";\n${assigned}\n`);
  const r = run('node', [path.join(ROOT, 'tools', 'scan.mjs'), dir]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /aws-access-key/);
  assert.match(r.stderr, /github-token/);
  assert.match(r.stderr, /assigned-secret/);
});

test('scan passes on clean code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-scan-clean-'));
  fs.writeFileSync(path.join(dir, 'fine.js'), 'const greeting = "hello";\n');
  const r = run('node', [path.join(ROOT, 'tools', 'scan.mjs'), dir]);
  assert.equal(r.status, 0);
});

// ── rollback (unit level, sandboxed environment) ────────────────────────────

test('rollbackEnv restores the previous deployed version', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-rollback-'));
  const envRoot = path.join(sandbox, 'prod');
  const artifactDir = path.join(sandbox, 'artifacts');
  // a smoke-testable bundle: rollback re-verifies the deployed artifact actually loads
  const bundle = [
    'function createTaskStore(){ return { tasks: new Map() }; }',
    'function addTask(s, t){ s.tasks.set(1, t); return t; }',
    'function stats(s){ return { total: s.tasks.size, open: s.tasks.size, done: 0, overdue: 0 }; }',
    'export { createTaskStore, addTask, stats };',
    '',
  ].join('\n');
  for (const [ver, marker] of [['1.0.0', 'first'], ['1.1.0', 'second']]) {
    const zip = path.join(artifactDir, `taskflow-${ver}.zip`);
    zipFiles([{ name: 'taskflow.mjs', data: Buffer.from(bundle) }, { name: 'marker.txt', data: Buffer.from(marker) }], zip);
  }
  writeJson(path.join(envRoot, 'manifest.json'), { env: 'prod', version: '1.1.0' });
  appendHistory(envRoot, { type: 'deploy', version: '1.0.0', at: '2026-10-01T00:00:00Z' });
  appendHistory(envRoot, { type: 'deploy', version: '1.1.0', at: '2026-10-02T00:00:00Z' });
  fs.mkdirSync(path.join(envRoot, 'app'));
  fs.writeFileSync(path.join(envRoot, 'app', 'marker.txt'), 'second');

  const logs = [];
  const ok = await rollbackEnv(envRoot, [artifactDir], l => logs.push(l));
  assert.equal(ok, true);
  assert.equal(fs.readFileSync(path.join(envRoot, 'app', 'marker.txt'), 'utf8'), 'first');
  const manifest = JSON.parse(fs.readFileSync(path.join(envRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.rolledBackFrom, '1.1.0');
  const history = JSON.parse(fs.readFileSync(path.join(envRoot, 'history.json'), 'utf8'));
  assert.equal(history.at(-1).type, 'rollback');
});

test('rollbackEnv refuses when only one version was ever deployed', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-rollback-single-'));
  const envRoot = path.join(sandbox, 'staging');
  writeJson(path.join(envRoot, 'manifest.json'), { env: 'staging', version: '2.0.0' });
  appendHistory(envRoot, { type: 'deploy', version: '2.0.0', at: '2026-10-01T00:00:00Z' });
  const ok = await rollbackEnv(envRoot, [sandbox], () => {});
  assert.equal(ok, false);
});

// ── integration (spawned pipeline runs) ─────────────────────────────────────

test('--dry-run prints the plan and executes nothing', () => {
  const runsDir = path.join(ROOT, '.pipeline', 'runs');
  const before = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort() : [];
  const r = run('node', ['pipeline.mjs', '--dry-run']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /lint → test → build → scan → package → deploy-dev → deploy-staging → deploy-prod/);
  assert.match(r.stdout, /DRY RUN/);
  const after = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort() : [];
  assert.deepEqual(after, before, 'a dry run must not record a run report');
});

test('--list prints the stage graph including approval gates', () => {
  const r = run('node', ['pipeline.mjs', '--list']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Deploy prod.*approval gate/);
});

test('full pipeline run (--yes) passes end to end and deploys prod', () => {
  const r = run('node', ['pipeline.mjs', '--yes']);
  assert.equal(r.status, 0, `pipeline failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /RUN SUMMARY.*SUCCESS/s);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'environments', 'prod', 'manifest.json'), 'utf8'));
  assert.ok(manifest.version);
  assert.ok(fs.existsSync(path.join(ROOT, 'environments', 'prod', 'app', 'taskflow.mjs')));
});

test('run report records every stage with a verdict', () => {
  const runsDir = path.join(ROOT, '.pipeline', 'runs');
  const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
  assert.ok(files.length >= 1);
  const report = JSON.parse(fs.readFileSync(path.join(runsDir, files.at(-1)), 'utf8'));
  assert.equal(report.verdict, 'success');
  assert.equal(report.stages.length, 8);
});
