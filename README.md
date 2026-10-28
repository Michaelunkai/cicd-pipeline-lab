# ⚡ cicd-pipeline-lab

**Learn CI/CD and DevOps by running a real pipeline — not by watching slides.**
A complete, zero-dependency pipeline engine you can read in one sitting, a
sample app it ships from commit to production, and a six-module curriculum
tied to every line of code.

```
  lint ──┬──▶ build ──▶ scan ──▶ package ──▶ deploy dev ──▶ staging 🚧 ──▶ prod 🚧
  test ──┘                                        (🚧 = approval gate)
```

---

## Why this exists

Every CI system — GitHub Actions, GitLab CI, Jenkins, Azure DevOps — is the
same machine under the hood: a **stage graph**, **artifacts**, **gates**, and
a **run report**. Most people only ever see the machine's buttons. This lab
*is* the machine, distilled to ~1000 readable, tested lines, so that when a
pipeline turns red at 2 AM you understand *which* part of it is speaking to
you.

- **Real engine** — dependency graph with cycle detection, failure
  propagation with skip reasons, retries, manual approval gates, secret
  masking in logs, per-run JSON reports.
- **Real artifact discipline** — build once into a CRC-checked ZIP with a
  sha256 manifest, then promote *the same bytes* dev → staging → prod.
- **Real rollback** — `rollback prod` re-extracts the previous known-good
  artifact and smoke-tests it. Seconds, not ceremonies.
- **Real CI** — the repo runs its own pipeline on GitHub Actions on every
  push (`.github/workflows/`), so the lab dogfoods its own lesson.
- **Zero dependencies** — everything (engine, linter, scanner, bundler, ZIP
  writer/reader) is plain Node. `npm install` is not in this project's
  vocabulary; the supply-chain attack surface is zero and every lesson is
  auditable.

## Quickstart

Requires [Node.js](https://nodejs.org) ≥ 18 (nothing else).

```bash
git clone https://github.com/Michaelunkai/cicd-pipeline-lab.git
cd cicd-pipeline-lab

node pipeline.mjs --yes        # full pipeline: 8 stages, gates auto-approved
node pipeline.mjs status       # what's "deployed" where
node pipeline.mjs rollback prod
```

On Windows, **double-click `Run-Pipeline.cmd`** for the guided tour.
The first run takes about half a second. Watch it go green, then head to the
[curriculum](#curriculum) and start breaking things.

## Usage

```bash
node pipeline.mjs                     # full pipeline (gates prompt if TTY)
node pipeline.mjs --yes               # full pipeline, gates auto-approved
node pipeline.mjs lint test           # selected stages — needs come along
node pipeline.mjs deploy-prod --yes   # one environment, one command
node pipeline.mjs --list              # the stage graph
node pipeline.mjs --dry-run           # the plan, no execution
node pipeline.mjs status              # environments + recent runs
node pipeline.mjs history 20          # run report browser
node pipeline.mjs rollback <env>      # re-deploy the previous artifact
node --test engine-tests/engine.test.mjs   # the engine tests itself (25 tests)
```

Exit codes: `0` all planned stages passed · `1` a stage failed (downstream
stages will be skipped, with reasons) · `2` usage/config error.

### The pipeline

| Stage | What it really does |
|---|---|
| `lint` | zero-dep linter: line length, tabs, `console.log`, `debugger`, `eval`, unresolved markers |
| `test` | 14-test unit suite over the sample app (`node --test`) |
| `build` | bundles to `dist/`, writes an SBOM-lite manifest (per-file sha256), smoke-imports the bundle |
| `scan` | secret scanning (AWS keys, GitHub tokens, private keys, generic assignments) over source **and build output** — blocks the release on any hit |
| `package` | freezes `dist/` into `artifacts/taskflow-<version>.zip` (STORE-method ZIP with CRC32, written from scratch in `tools/zip.mjs`) |
| `deploy-dev/staging/prod` | extracts the artifact into `environments/<env>/`, verifies checksum, smoke-tests the deployed code, records manifest + history |

`staging` and `prod` sit behind **approval gates** — interactive `[y/N]` in a
terminal, explicit `--yes` in automation, hard failure if an unattended run
tries to sneak past. That behavior is the whole lesson of gated delivery.

### A five-minute tour

```bash
node pipeline.mjs --yes                     # ① everything green
# ② break a test: append a failing assert to app/test/taskflow.test.js
node pipeline.mjs --yes                     # ③ red at "Unit tests", everything
                                            #    downstream SKIPPED with reasons
# ④ leak a secret: echo "const k = 'AKIAABCDEFGHIJKLMNOP';" >> app/src/taskflow.mjs
node pipeline.mjs --yes                     # ⑤ scan catches it in src AND dist
# undo ② and ④, then live the deployment story:
node pipeline.mjs --yes                     # v1.0.0 everywhere
# bump "version" in app/package.json → 1.1.0
node pipeline.mjs --yes                     # v1.1.0 everywhere
node pipeline.mjs rollback prod             # prod back on 1.0.0 in <1s
node pipeline.mjs status                    # mixed versions, full audit trail
```

## Curriculum

Six modules, each tied to code in this repo and exercises that modify it:

| # | Module | Core idea |
|---|---|---|
| 1 | [CI/CD Fundamentals](docs/01-ci-cd-fundamentals.md) | integration → delivery → deployment; the stage graph; trunk-based dev |
| 2 | [Pipeline Anatomy](docs/02-pipeline-anatomy.md) | DAGs, artifacts, gates, secret masking, caching — in GitHub/GitLab/Jenkins/Azure dialects |
| 3 | [DevOps Culture & DORA](docs/03-devops-culture-and-dora.md) | CALMS, the four key metrics, shift-left, SRE & error budgets |
| 4 | [Deployment Strategies](docs/04-deployment-strategies.md) | rolling, blue/green, canary, feature flags — and rollback as a first-class op |
| 5 | [Security in the Pipeline](docs/05-security-in-the-pipeline.md) | secret scanning, least privilege, SBOM, provenance, supply chain |
| 6 | [GitOps & the Real World](docs/06-gitops-and-real-world.md) | pull vs push GitOps, observability, containers, engine tour, 30-day plan |

## Project layout

```
pipeline.mjs          the engine: DAG, gates, masking, reports, CLI
pipeline.json         the pipeline definition — the only file you edit to re-shape it
app/                  taskflow — the sample app being shipped (src + 14 tests)
tools/                stage implementations: lint, build, scan, package, deploy, zip
environments/         simulated deployment targets: dev / staging / prod + history
engine-tests/         25 tests: the pipeline under test
docs/                 the six-module curriculum
.github/workflows/    the same pipeline running for real on GitHub Actions
Run-Pipeline.cmd      Windows double-click launcher
```

## Configuration

Everything lives in `pipeline.json`:

```jsonc
{
  "name": "taskflow",
  "secrets": ["TASKFLOW_DEPLOY_TOKEN"],   // env vars masked in all stage output
  "stages": [
    { "id": "deploy-prod", "name": "Deploy prod",
      "run": "node tools/deploy.mjs prod",
      "needs": ["deploy-staging"],          // dependency edges — any DAG you like
      "approval": true,                     // manual gate in front of this stage
      "retries": 0,                         // extra attempts on failure
      "artifacts": ["dist/"] }              // patterns snapshotted per run
  ]
}
```

The engine enforces the graph (cycles are rejected with the offending stage),
skips dependents of failures with printed reasons, and records attempts,
durations and artifact hashes for every run.

## Build from source

There is nothing to build — that's the point. Clone and run. To package a
fresh artifact yourself: `node pipeline.mjs build scan package` then pick up
`artifacts/taskflow-<version>.zip`.

## Install (no build, no dependencies)

- **Download** the latest `cicd-pipeline-lab-<version>.zip` from
  [Releases](https://github.com/Michaelunkai/cicd-pipeline-lab/releases),
  extract anywhere, and run `node pipeline.mjs --yes` (or double-click
  `Run-Pipeline.cmd` on Windows).
- Or the one-liner, with Git available:
  `git clone https://github.com/Michaelunkai/cicd-pipeline-lab.git && cd cicd-pipeline-lab && node pipeline.mjs --yes`

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `approval required and stdin is not interactive` | a gated stage ran unattended → add `--yes` (or don't: the refusal is the feature) |
| `artifact … not found` at a deploy stage | you ran a deploy without its needs → run `node pipeline.mjs deploy-dev` (pulls the chain) or the full pipeline |
| `nothing to roll back to` | only one version was ever deployed → deploy a second version first |
| `Cannot find module` on the test stage | run from the repo root; on Git Bash use the shipped commands verbatim (they avoid directory-arg path quirks) |
| CRC mismatch during deploy | the artifact zip was modified after packaging → rerun `build package` |

## License

[MIT](LICENSE) © Michaelunkai
