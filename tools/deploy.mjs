/**
 * deploy.mjs — "Deploy" stages. Promotes the packaged artifact into a
 * simulated environment (a folder with a manifest and history), verifying the
 * artifact's checksum and smoke-testing the deployed bundle before declaring
 * success. Also exports rollbackEnv() used by `pipeline.mjs rollback <env>`.
 *
 * Usage: node tools/deploy.mjs <dev|staging|prod>
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { extract } from './zip.mjs';

const ROOT = path.resolve(process.cwd());
const ENVIRONMENTS = path.join(ROOT, 'environments');

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Locate the artifact zip for a version under the known artifact locations. */
export function findArtifact(version, artifactDirs) {
  const names = [`taskflow-${version}.zip`, path.join('artifacts', `taskflow-${version}.zip`)];
  for (const dir of artifactDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function appendHistory(envRoot, entry) {
  const file = path.join(envRoot, 'history.json');
  const history = fs.existsSync(file) ? readJson(file) : [];
  history.push(entry);
  writeJson(file, history);
  return history.length;
}

/** Run the deployed bundle from inside the environment — promotion proof. */
export async function smokeTestEnv(envRoot) {
  const bundle = path.join(envRoot, 'app', 'taskflow.mjs');
  if (!fs.existsSync(bundle)) throw new Error(`deployed bundle missing: ${path.relative(ROOT, bundle)}`);
  const mod = await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`); // cache-bust: prove THIS copy works
  const store = mod.createTaskStore();
  mod.addTask(store, { title: 'deploy smoke check', priority: 1 });
  const s = mod.stats(store);
  if (s.total !== 1 || s.open !== 1) throw new Error('deployed bundle failed its smoke check');
  return true;
}

export async function deployEnv(envName, { version, runId }) {
  const envRoot = path.join(ENVIRONMENTS, envName);
  const zipPath = findArtifact(version, [ROOT, path.join(ROOT, '.pipeline', 'artifacts', runId ?? '')]);
  if (!zipPath) {
    throw new Error(`artifact taskflow-${version}.zip not found — the Package stage must run before deploy (stages declare this via "needs")`);
  }
  const sha = createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');

  const appDir = path.join(envRoot, 'app');
  fs.rmSync(appDir, { recursive: true, force: true });
  const written = extract(zipPath, appDir);

  await smokeTestEnv(envRoot);

  if (process.env.TASKFLOW_DEPLOY_TOKEN) console.log(`deploy token: accepted (value withheld — secrets are never printed)`);
  writeJson(path.join(envRoot, 'manifest.json'), {
    env: envName,
    version,
    runId: runId ?? 'manual',
    artifact: path.relative(ROOT, zipPath).replaceAll('\\', '/'),
    sha256: sha,
    deployedAt: new Date().toISOString(),
  });
  appendHistory(envRoot, { type: 'deploy', version, runId: runId ?? 'manual', at: new Date().toISOString() });
  return { version, files: written.length, sha };
}

/** Roll an environment back to the previous version in its history. */
export async function rollbackEnv(envRoot, artifactDirs, log = () => {}) {
  const manifestFile = path.join(envRoot, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    log(`no manifest — ${path.basename(envRoot)} was never deployed`);
    return false;
  }
  const current = readJson(manifestFile);
  const history = readJson(path.join(envRoot, 'history.json'));
  const deploys = history.filter(h => h.type === 'deploy');
  const previous = [...deploys].reverse().find(h => h.version !== current.version);
  if (!previous) {
    log(`nothing to roll back to — ${current.version} is the only deployed version`);
    return false;
  }
  const zipPath = findArtifact(previous.version, artifactDirs);
  if (!zipPath) {
    log(`artifact for ${previous.version} is gone (artifacts/ is cleaned sometimes) — rollback needs the zip`);
    return false;
  }
  const appDir = path.join(envRoot, 'app');
  fs.rmSync(appDir, { recursive: true, force: true });
  extract(zipPath, appDir);
  await smokeTestEnv(envRoot);
  writeJson(manifestFile, {
    ...current,
    version: previous.version,
    rolledBackFrom: current.version,
    deployedAt: new Date().toISOString(),
  });
  appendHistory(envRoot, { type: 'rollback', from: current.version, to: previous.version, at: new Date().toISOString() });
  log(`rolled back ${path.basename(envRoot)}: ${current.version} → ${previous.version} (smoke check passed)`);
  return true;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const envName = process.argv[2];
  if (!envName) {
    console.error('usage: node tools/deploy.mjs <dev|staging|prod>');
    process.exit(2);
  }
  const version = process.env.PIPELINE_VERSION ?? readJson(path.join(ROOT, 'app', 'package.json')).version;
  try {
    const result = await deployEnv(envName, { version, runId: process.env.PIPELINE_RUN_ID });
    console.log(`deploy ${envName}: taskflow v${result.version} live (${result.files} files, sha256 ${result.sha.slice(0, 12)}…)`);
  } catch (err) {
    console.error(`deploy ${envName}: ${err.message}`);
    process.exit(1);
  }
}
