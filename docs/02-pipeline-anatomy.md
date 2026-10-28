# Module 2 — Pipeline Anatomy: stages, artifacts, gates, caching

> Goal: master the moving parts you will meet in every CI system, by reading
> the implementations in this repo instead of trusting magic.

## 2.1 The stage DAG

Stages in `pipeline.json` form a **directed acyclic graph**. Two properties
matter:

1. **Order** — a topological sort turns the graph into an execution sequence
   (`topoSort()` in `pipeline.mjs`). Cycle? The engine refuses to run and tells
   you the offending stage — the same failure you'd get from a cyclic `needs`
   in GitHub Actions or a cyclic `depends_on` in GitLab CI.
2. **Failure propagation** — when a stage fails, every stage that needs it
   (transitively) is **skipped with a reason**, not run. Find this in
   `skippedBecause()` and in the run summary (`skip — need "test" did not
   succeed (failed)`). "Skipped" is a first-class outcome, distinct from
   "passed" and "failed", in every serious CI system.

## 2.2 Jobs and parallelism

Real pipelines run independent graph branches **in parallel**: `lint` and
`test` share no needs, so a real runner starts them simultaneously. This lab
runs serially for readability — but the graph already encodes the
parallelizable sets, which is exactly what `GitHub Actions` does when you give
two jobs no interdependency. Watch for it in the CI logs of this very repo:
the engine tests and the pipeline run are two independent steps.

## 2.3 Artifacts — what you test is what you ship

An **artifact** is an immutable file produced by one stage and consumed by
later ones. The discipline it enforces is the single most important idea in
delivery:

> **Build once, promote the same bytes everywhere.**

This lab implements it literally:

- `build` writes `dist/` and a manifest with a **sha256 per file** (an
  SBOM-lite — software bill of materials).
- `package` freezes `dist/` into `artifacts/taskflow-<version>.zip`
  (a real ZIP, written byte-by-byte by `tools/zip.mjs` with CRC32 checks).
- Every `deploy` extracts **that zip** — not a rebuild — into the environment,
  records the artifact's sha256 in the environment manifest, and smoke-tests
  the extracted code.
- `rollback` re-extracts a *previous* artifact. Rollback is re-deployment of a
  known-good artifact, never "git revert and hope it rebuilds".

Find each of those in `tools/build.mjs`, `tools/package.mjs`,
`tools/deploy.mjs`.

## 2.4 Gates — humans in the loop

A **gate** pauses the pipeline until a human (or a policy) allows it to
continue. In this lab, `deploy-staging` and `deploy-prod` declare
`"approval": true`:

- Interactive terminal → the engine asks `approve stage "Deploy prod"? [y/N]`.
- Automation (`--yes`) → auto-approved, *and the log says so explicitly*.
- Automation without `--yes` → the stage **fails** with a clear reason — an
  unattended pipeline must never silently wait forever.

Real-world equivalents: GitHub **environments with required reviewers**,
GitLab **protected environments**, Jenkins **input steps**, Azure DevOps
**environment approvals**. Same idea, different buttons.

## 2.5 Secrets and log masking

Stage output in this lab is filtered through `maskSecrets()` before printing
or reporting: any value of an environment variable named in `pipeline.json`'s
`secrets` list becomes `***`. Set one and watch:

```bash
TASKFLOW_DEPLOY_TOKEN=super-secret-value node pipeline.mjs deploy-dev
```

`tools/deploy.mjs` deliberately never prints the token even when it uses it.
The two rules being modeled:

1. Secrets enter as **environment variables injected by the CI system** —
   never as files in the repo (module 5's scanner exists to enforce this).
2. Logs are **assumed public** — mask before writing, because a secret that
   reached a log is already burned and must be rotated.

## 2.6 Caching and speed

Pipelines people avoid get bypassed. The classic speed tools:

- **Dependency caching** — restore `node_modules`/`~/.nuget`/`~/.gradle` by
   lockfile hash instead of re-downloading (GitHub: `actions/cache`).
- **Test selection** — run only tests affected by the change.
- **Parallel sharding** — split the suite across N machines.

This lab needs almost none of it (zero dependencies is a design choice that
keeps it honest and instant). To feel the pain it avoids, imagine `npm ci`
downloading 800 packages before every `lint`.

## 2.7 Reports and audit

Every run writes `.pipeline/runs/<run-id>.json`: who ran what, in which order,
with what durations, attempts, artifacts, and a verdict. `node pipeline.mjs
status` and `history` read it back. In a real system this is the run page you
link in a chat when you say "the pipeline is red". The lab's report has
exactly the fields you'd scrape to build DORA metrics (module 3).

## The same pipeline, four dialects

The stage graph below is this lab's `pipeline.json` — translated so you can
recognize it anywhere:

**GitHub Actions** (see `.github/workflows/ci.yml` — this repo runs it for real):

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node --test engine-tests/
      - run: node pipeline.mjs lint test build scan package deploy-dev --yes
      - uses: actions/upload-artifact@v4
        with: { path: artifacts/*.zip }
```

**GitLab CI**:

```yaml
stages: [verify, build, deploy]
unit:
  stage: verify
  script: node --test app/test/taskflow.test.js
deploy-dev:
  stage: deploy
  script: node tools/deploy.mjs dev
  environment: dev
```

**Jenkins (declarative)**:

```groovy
pipeline {
  stages {
    stage('Deploy') {
      input { message 'Approve production deploy?' }
      steps { sh 'node tools/deploy.mjs prod' }
    }
  }
}
```

**Azure DevOps**:

```yaml
stages:
- stage: Deliver
  jobs:
  - deployment: DeployProd
    environment: prod        # environment carries the approval policy
    strategy: { runOnce: { deploy: { steps: [script: node tools/deploy.mjs prod] } } }
```

## Exercises

1. Make `lint` and `test` depend on a new stage `checkout-sim` (add it to
   `pipeline.json` with `"run": "node -e \"console.log('checked out')\""`)
   — rerun and watch the plan.
2. Introduce a cycle (`build` needs `package`) and read the engine's error.
3. Break a test, run the pipeline, then read the run JSON in
   `.pipeline/runs/` — find the `skipped` statuses and the failing stage's
   `exitCode`.
4. Corrupt a byte inside `artifacts/taskflow-1.0.0.zip` and run
   `node pipeline.mjs deploy-prod --yes` — the CRC check in `tools/zip.mjs`
   refuses it. That refusal is artifact integrity doing its job.
