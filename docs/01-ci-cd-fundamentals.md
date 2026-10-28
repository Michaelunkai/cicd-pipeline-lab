# Module 1 — CI/CD Fundamentals

> Goal: understand what Continuous Integration and Continuous Delivery/Deployment
> actually are, why they exist, and how the pipeline in this lab expresses them.

## 1.1 The problem CI/CD solves

Before CI, teams merged weeks or months of work in painful "integration
marathons". Code written apart assumed different things about the world, and
putting it together broke constantly. Continuous Integration attacks that by
making integration continuous: everyone merges small changes to a shared main
branch frequently, and an automated pipeline verifies every single change.

The economic insight: **the cost of fixing a defect grows with the distance
between where it was introduced and where it was caught**. A failing lint 10
seconds after you save the file costs seconds. The same defect found in
production costs an incident, a rollback, and customer trust.

## 1.2 CI, CD, CD — three terms, one ladder

| Rung | Name | Meaning | Human step |
|---|---|---|---|
| 1 | Continuous **Integration** | every change is built + tested automatically | merge the change |
| 2 | Continuous **Delivery** | every green build is packaged and staged, *ready* to release | someone presses "release" |
| 3 | Continuous **Deployment** | every green build is released to production | none — code flows to users |

Delivery vs Deployment is the most commonly confused pair. The difference is
only *who flips the final switch* — a human (delivery) or the pipeline
(deployment). This lab models rung 3 with speed bumps: the `deploy-staging` and
`deploy-prod` stages have **approval gates**, which is exactly how a team at
rung 2 behaves.

## 1.3 Anatomy of a pipeline

Every CI system — GitHub Actions, GitLab CI, Jenkins, Azure DevOps, CircleCI —
uses the same mental model, and so does `pipeline.json` in this repo:

```
trigger ──▶ stages (a dependency graph) ──▶ verdict + report
              │
              ├── jobs   : one stage can fan out into parallel jobs
              ├── steps  : the commands inside a stage
              ├── gates  : points where the pipeline must be allowed to continue
              └── artifacts : immutable files passed between stages
```

Read `pipeline.json` alongside this:

- **`id` / `name`** — the stage's machine and human identity.
- **`needs`** — the edges of the dependency graph. `build` needs `lint` *and*
  `test`; `deploy-prod` transitively needs everything.
- **`run`** — the command the stage executes (a real process with an exit code;
  exit 0 = pass, anything else = fail).
- **`artifacts`** — files the stage produces, snapshotted into the run folder
  (`.pipeline/artifacts/<run-id>/`).
- **`approval`** — a manual gate in front of the stage.

## 1.4 Walk the ladder in this lab

Run each command and watch how the plan changes:

```bash
node pipeline.mjs --list          # see the graph
node pipeline.mjs --dry-run       # the full plan, no execution
node pipeline.mjs lint            # ONE stage — CI in miniature
node pipeline.mjs deploy-dev      # pulls its transitive needs automatically
node pipeline.mjs --yes           # the whole ladder, gates auto-approved
```

The printed `plan: lint → test → build → …` line is the **topological order**
of the stage graph — the same algorithm every real CI scheduler runs. It lives
in `topoSort()` in `pipeline.mjs`, and it is 15 lines you can read.

## 1.5 Trunk-based development vs GitFlow

A pipeline is only as healthy as the branching model feeding it:

- **Trunk-based**: everyone merges to `main` in small pieces, feature flags
  hide unfinished work. Pipelines run per-merge, fast and green. This is what
  modern CI/CD assumes (and what this repo's `.github/workflows/ci.yml` does —
  it runs on every push to `main` and every pull request).
- **GitFlow**: long-lived `develop`/`release`/`hotfix` branches. Safer feeling,
  but merges are big, integration is late, and pipelines become release
  ceremonies instead of feedback loops.

Rule of thumb from the DORA research (see module 3): smaller batches, more
often. A pipeline that runs 30 times a day teaches you something every 30
minutes; a pipeline that runs once a week is a lottery.

## 1.6 What "green" must mean

A green run is a *claim*: "this exact commit, built and tested automatically,
is releasable." That claim is only as strong as its weakest stage:

- Tests that assert nothing make green meaningless.
- A stage that ignores failures (exiting 0 on error) is worse than no stage.
- A pipeline that is red half the time trains everyone to ignore red.

In this lab the engine is honest on purpose: a stage fails if its process
exits non-zero, downstream stages are skipped with a printed reason, and the
run's exit code is 1. Try it — break a test and watch the ladder refuse.

## Exercises

1. `node pipeline.mjs lint` then `node pipeline.mjs build`. Which stages ran
   the second time, and why? (Answer: `build` pulled `lint` + `test` through
   `needs` — check the printed plan.)
2. Add `"retries": 2` to the `test` stage in `pipeline.json` and make a test
   fail. Watch the engine retry before declaring failure.
3. Open `.github/workflows/ci.yml` and find the YAML equivalents of `needs`,
   `run`, and the artifact upload this lab implements by hand.
