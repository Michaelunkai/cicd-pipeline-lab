#!/usr/bin/env node
/**
 * pipeline.mjs — the heart of cicd-pipeline-lab.
 *
 * A zero-dependency CI/CD pipeline engine. It reads pipeline.json, resolves the
 * stage dependency graph (DAG), runs each stage as a child process, streams
 * masked output, enforces manual approval gates, collects artifacts, and writes
 * a structured run report — the same anatomy as GitHub Actions / GitLab CI /
 * Jenkins, implemented in one readable file you can actually study.
 *
 * CLI:
 *   node pipeline.mjs                     full pipeline
 *   node pipeline.mjs lint test           selected stages (their needs come too)
 *   node pipeline.mjs --list              show the stage graph
 *   node pipeline.mjs --dry-run           print the execution plan, run nothing
 *   node pipeline.mjs --yes               auto-approve approval-gated stages
 *   node pipeline.mjs rollback prod       roll an environment back one version
 *   node pipeline.mjs status              environments + last run
 *   node pipeline.mjs history [n]         last n run reports
 *
 * Exit codes: 0 = every planned stage passed, 1 = at least one stage failed,
 * 2 = usage or configuration error.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_FILE = path.join(ROOT, 'pipeline.json');
const APP_PKG_FILE = path.join(ROOT, 'app', 'package.json');
const RUNS_DIR = path.join(ROOT, '.pipeline', 'runs');
const RUN_ARTIFACTS_DIR = path.join(ROOT, '.pipeline', 'artifacts');
const ENVIRONMENTS_DIR = path.join(ROOT, 'environments');

const C = process.env.NO_COLOR
  ? { green: s => s, red: s => s, yellow: s => s, cyan: s => s, dim: s => s, bold: s => s }
  : {
      green: s => `\x1b[32m${s}\x1b[0m`,
      red: s => `\x1b[31m${s}\x1b[0m`,
      yellow: s => `\x1b[33m${s}\x1b[0m`,
      cyan: s => `\x1b[36m${s}\x1b[0m`,
      dim: s => `\x1b[2m${s}\x1b[0m`,
      bold: s => `\x1b[1m${s}\x1b[0m`,
    };

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in engine-tests/engine.test.mjs)
// ---------------------------------------------------------------------------

/** Topologically sort stages by their `needs`. Throws on unknown ids and cycles. */
export function topoSort(stages) {
  const byId = new Map(stages.map(s => [s.id, s]));
  for (const s of stages) {
    for (const need of s.needs ?? []) {
      if (!byId.has(need)) throw new Error(`stage "${s.id}" needs unknown stage "${need}"`);
    }
  }
  const order = [];
  const state = new Map(); // id -> 'visiting' | 'done'
  const visit = id => {
    const st = state.get(id);
    if (st === 'done') return;
    if (st === 'visiting') throw new Error(`dependency cycle detected involving "${id}"`);
    state.set(id, 'visiting');
    for (const need of byId.get(id).needs ?? []) visit(need);
    state.set(id, 'done');
    order.push(id);
  };
  for (const s of stages) visit(s.id);
  return order;
}

/** Ordered ids for a run: the requested stages plus every transitive need. */
export function planRun(stages, requested) {
  const byId = new Map(stages.map(s => [s.id, s]));
  const full = topoSort(stages);
  if (!requested.length) return full;
  const keep = new Set();
  const pull = id => {
    if (keep.has(id)) return;
    keep.add(id);
    for (const need of byId.get(id).needs ?? []) pull(need);
  };
  for (const r of requested) {
    if (!byId.has(r)) throw new Error(`unknown stage "${r}" (use --list to see stages)`);
    pull(r);
  }
  return full.filter(id => keep.has(id));
}

/** Replace every secret value with *** so tokens never reach logs or reports. */
export function maskSecrets(text, secretValues) {
  let out = text;
  for (const v of secretValues) {
    if (v && v.length >= 4) out = out.split(v).join('***');
  }
  return out;
}

/** Match artifact patterns: "dir/" (whole tree), "dir/**", "dir/*.ext", "*.ext", exact path. */
export function matchPath(relPath, pattern) {
  if (pattern.endsWith('/**')) return relPath.startsWith(pattern.slice(0, -2));
  if (pattern.endsWith('/')) return relPath.startsWith(pattern);
  const starExt = /^(.*\/)?\*(\.[A-Za-z0-9]+)$/.exec(pattern);
  if (starExt) return (!starExt[1] || relPath.startsWith(starExt[1])) && relPath.endsWith(starExt[2]);
  return relPath === pattern;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function newRunId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `run-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${rand}`;
}

/** Which stages end up skipped because a need did not succeed. */
export function skippedBecause(statuses, stages) {
  const byId = new Map(stages.map(s => [s.id, s]));
  const reason = new Map();
  for (const s of stages) {
    for (const need of s.needs ?? []) {
      if (statuses.get(need) !== 'success' && !reason.has(s.id)) {
        reason.set(s.id, `need "${need}" did not succeed (${statuses.get(need) ?? 'not run'})`);
      }
    }
  }
  return reason;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function loadConfig() {
  if (!fs.existsSync(PIPELINE_FILE)) throw new Error(`pipeline definition not found: ${PIPELINE_FILE}`);
  const cfg = JSON.parse(fs.readFileSync(PIPELINE_FILE, 'utf8'));
  if (!Array.isArray(cfg.stages) || cfg.stages.length === 0) throw new Error('pipeline.json must define a non-empty "stages" array');
  return cfg;
}

function loadAppVersion() {
  const pkg = JSON.parse(fs.readFileSync(APP_PKG_FILE, 'utf8'));
  return pkg.version;
}

/** Collect files matched by artifact patterns into the run's artifact folder. */
function collectArtifacts(runId, patterns) {
  const destDir = path.join(RUN_ARTIFACTS_DIR, runId);
  const collected = [];
  for (const pattern of patterns) {
    const walk = (abs, rel) => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const childAbs = path.join(abs, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(childAbs, childRel);
        else if (matchPath(childRel, pattern)) {
          const data = fs.readFileSync(childAbs);
          const dest = path.join(destDir, childRel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(childAbs, dest);
          collected.push({ path: childRel, bytes: data.length, sha256: sha256(data) });
        }
      }
    };
    walk(ROOT, '');
  }
  return collected;
}

/** Run one command, stream masked output line by line. Resolves {code, durationMs}. */
function runCommand(stageId, cmd, { env, mask, quiet = false }) {
  return new Promise(resolve => {
    const started = performance.now();
    const parts = cmd.split(' ');
    const child = spawn(parts[0], parts.slice(1), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let pendingOut = '';
    let pendingErr = '';
    const emit = (chunk, pending, stream) => {
      pending += chunk.toString();
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        if (line.trim() && !quiet) console.log(`  ${C.dim(`[${stageId}]`)} ${mask(line)}`);
      }
      return pending;
    };
    child.stdout.on('data', d => (pendingOut = emit(d, pendingOut)));
    child.stderr.on('data', d => (pendingErr = emit(d, pendingErr)));
    child.on('error', err => {
      console.log(`  ${C.red(`[${stageId}] cannot start: ${err.message}`)}`);
      resolve({ code: 1, durationMs: performance.now() - started });
    });
    child.on('close', code => resolve({ code: code ?? 1, durationMs: performance.now() - started }));
  });
}

/** Manual approval gate — the lab's model of a protected deployment environment. */
async function approve(stage, autoYes) {
  if (autoYes) {
    console.log(`  ${C.yellow(`[gate] approval for "${stage.name}" auto-granted (--yes)`)}`);
    return true;
  }
  if (!process.stdin.isTTY) {
    console.log(`  ${C.red(`[gate] "${stage.name}" requires approval and stdin is not interactive (pass --yes in automation)`)}`);
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question(`  ${C.yellow(`[gate] approve stage "${stage.name}"? [y/N] `)}`, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function executePlan(cfg, planIds, opts) {
  const byId = new Map(cfg.stages.map(s => [s.id, s]));
  const secretValues = (cfg.secrets ?? []).map(n => process.env[n]).filter(Boolean);
  const mask = t => maskSecrets(t, secretValues);
  const statuses = new Map();
  const details = new Map();
  const runId = opts.runId;
  let anyFailed = false;

  console.log('');
  for (const id of planIds) {
    const stage = byId.get(id);
    const skipReason = skippedBecause(statuses, [stage]).get(id);
    if (skipReason && statuses.size > 0 && planIds.length > 1) {
      statuses.set(id, 'skipped');
      details.set(id, { note: skipReason });
      console.log(`${C.yellow('■')} ${C.bold(stage.name)}  ${C.yellow('SKIPPED')} — ${skipReason}`);
      continue;
    }
    console.log(`${C.cyan('■')} ${C.bold(stage.name)}  ${C.dim(`(${id})`)}`);

    if (stage.approval && !(await approve(stage, opts.yes))) {
      statuses.set(id, 'failed');
      anyFailed = true;
      details.set(id, { note: 'approval denied at gate' });
      console.log(`  ${C.red('gate not approved — stage failed')}`);
      continue;
    }

    const env = {
      ...process.env,
      PIPELINE_RUN_ID: runId,
      PIPELINE_STAGE: id,
      PIPELINE_VERSION: opts.version,
    };
    let attempt = 0;
    const maxAttempts = 1 + (stage.retries ?? 0);
    let result = { code: 1, durationMs: 0 };
    while (attempt < maxAttempts) {
      attempt++;
      result = await runCommand(id, stage.run, { env, mask });
      if (result.code === 0) break;
      if (attempt < maxAttempts) console.log(`  ${C.yellow(`attempt ${attempt} failed (exit ${result.code}) — retrying (${maxAttempts - attempt} left)`)}`);
    }

    if (result.code === 0) {
      const artifacts = stage.artifacts ? collectArtifacts(runId, stage.artifacts) : [];
      statuses.set(id, 'success');
      details.set(id, { durationMs: Math.round(result.durationMs), attempts: attempt, artifacts });
      console.log(`  ${C.green(`PASS (${(result.durationMs / 1000).toFixed(2)}s${attempt > 1 ? `, attempt ${attempt}` : ''}${artifacts.length ? `, ${artifacts.length} artifact file(s)` : ''})`)}`);
    } else {
      statuses.set(id, 'failed');
      anyFailed = true;
      details.set(id, { durationMs: Math.round(result.durationMs), attempts: attempt, exitCode: result.code });
      console.log(`  ${C.red(`FAIL (exit ${result.code}${attempt > 1 ? ` after ${attempt} attempts` : ''})`)}`);
    }
  }
  return { statuses, details, anyFailed };
}

function printSummary(cfg, planIds, statuses, details, totalMs) {
  console.log(`\n${C.bold('─'.repeat(64))}`);
  const verdictOk = planIds.every(id => statuses.get(id) === 'success');
  console.log(`${C.bold('RUN SUMMARY')}  ${verdictOk ? C.green('✔ SUCCESS') : C.red('✘ FAILED')}${C.dim(`  (${(totalMs / 1000).toFixed(2)}s)`)}`);
  for (const id of planIds) {
    const st = statuses.get(id);
    const d = details.get(id) ?? {};
    const label = st === 'success' ? C.green('pass') : st === 'skipped' ? C.yellow('skip') : C.red('FAIL');
    const secs = d.durationMs != null ? `${(d.durationMs / 1000).toFixed(2)}s` : '  —  ';
    const note = d.note ? C.dim(`  ${d.note}`) : d.artifacts?.length ? C.dim(`  ${d.artifacts.length} artifact file(s)`) : '';
    console.log(`  ${(cfg.stages.find(s => s.id === id).name ?? id).padEnd(16)} ${label}  ${secs}${note}`);
  }
  console.log(C.bold('─'.repeat(64)));
}

function writeReport(runId, cfg, planIds, statuses, details, totalMs, version) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const m = runId.match(/^run-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/);
  const startedAt = m
    ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString()
    : new Date().toISOString();
  const report = {
    runId,
    pipeline: cfg.name,
    version,
    startedAt,
    verdict: planIds.every(id => statuses.get(id) === 'success') ? 'success' : 'failed',
    totalMs: Math.round(totalMs),
    stages: planIds.map(id => ({
      id,
      name: cfg.stages.find(s => s.id === id).name,
      status: statuses.get(id),
      ...(details.get(id) ?? {}),
    })),
  };
  const file = path.join(RUNS_DIR, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdStatus() {
  console.log(C.bold('\nENVIRONMENTS'));
  for (const env of ['dev', 'staging', 'prod']) {
    const manifest = path.join(ENVIRONMENTS_DIR, env, 'manifest.json');
    if (fs.existsSync(manifest)) {
      const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      console.log(`  ${env.padEnd(9)} ${C.green(m.version)}  ${C.dim(`deployed ${m.deployedAt} from ${m.runId}`)}`);
    } else {
      console.log(`  ${env.padEnd(9)} ${C.dim('never deployed')}`);
    }
  }
  const runs = fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.json')).sort().reverse() : [];
  console.log(C.bold('\nLAST RUNS'));
  if (!runs.length) console.log(`  ${C.dim('no runs yet — run: node pipeline.mjs')}`);
  for (const f of runs.slice(0, 5)) {
    const r = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
    const v = r.verdict === 'success' ? C.green(r.verdict) : C.red(r.verdict);
    console.log(`  ${r.runId}  ${v}${C.dim(`  ${r.stages.length} stages, ${(r.totalMs / 1000).toFixed(1)}s`)}`);
  }
  console.log('');
}

function cmdHistory(n = 10) {
  const runs = fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.json')).sort().reverse() : [];
  if (!runs.length) return console.log(C.dim('no runs recorded yet'));
  for (const f of runs.slice(0, n)) {
    const r = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
    const v = r.verdict === 'success' ? C.green('success') : C.red('failed ');
    const stageSummary = r.stages.map(s => (s.status === 'success' ? C.green('●') : s.status === 'skipped' ? C.yellow('○') : C.red('✘'))).join(' ');
    console.log(`  ${r.runId}  ${v}  ${stageSummary}`);
  }
}

async function cmdRollback(envName) {
  if (!['dev', 'staging', 'prod'].includes(envName)) {
    console.error(C.red(`unknown environment "${envName}" (expected dev | staging | prod)`));
    process.exitCode = 2;
    return;
  }
  const { rollbackEnv } = await import('./tools/deploy.mjs');
  const ok = rollbackEnv(path.join(ENVIRONMENTS_DIR, envName), [path.join(ROOT, 'artifacts'), RUN_ARTIFACTS_DIR], line => console.log(`  ${line}`));
  process.exitCode = ok ? 0 : 1;
}

function printList(cfg) {
  const byId = new Map(cfg.stages.map(s => [s.id, s]));
  console.log(`\n${C.bold(cfg.name)} — stages\n`);
  for (const s of cfg.stages) {
    const needs = s.needs?.length ? C.dim(`needs: ${s.needs.join(', ')}`) : C.dim('entry stage');
    const gate = s.approval ? C.yellow('  [approval gate]') : '';
    console.log(`  ${s.id.padEnd(15)} ${C.bold(s.name)}${gate}  ${needs}`);
  }
  console.log('');
}

async function main(argv) {
  const opts = { yes: false, dryRun: false, runId: newRunId() };
  const positional = [];
  for (const a of argv) {
    if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--list' || a === '-l') return printList(loadConfig());
    else if (a === '--help' || a === '-h') return console.log(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').split('## Usage')[1]?.split('##')[0] ?? 'see README.md');
    else positional.push(a);
  }

  const cfg = loadConfig();
  const version = loadAppVersion();

  if (positional[0] === 'status') return cmdStatus();
  if (positional[0] === 'history') return cmdHistory(Number(positional[1] ?? 10));
  if (positional[0] === 'rollback') return cmdRollback(positional[1]);

  let planIds;
  try {
    planIds = planRun(cfg.stages, positional.filter(p => !p.startsWith('-')));
  } catch (err) {
    console.error(C.red(err.message));
    process.exitCode = 2;
    return;
  }

  console.log(C.bold(`\n⚡ ${cfg.name} v${version} — pipeline run ${C.cyan(opts.runId)}`));
  console.log(C.dim(`   plan: ${planIds.join(' → ')}`));

  if (opts.dryRun) {
    console.log(C.yellow('\nDRY RUN — nothing executed.\n'));
    return;
  }

  const started = performance.now();
  const { statuses, details, anyFailed } = await executePlan(cfg, planIds, { ...opts, version });
  const totalMs = performance.now() - started;
  printSummary(cfg, planIds, statuses, details, totalMs);
  const reportFile = writeReport(opts.runId, cfg, planIds, statuses, details, totalMs, version);
  console.log(C.dim(`report: ${path.relative(ROOT, reportFile)}`));
  process.exitCode = anyFailed ? 1 : 0;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2)).catch(err => {
    console.error(C.red(`pipeline error: ${err.message}`));
    process.exitCode = 2;
  });
}
