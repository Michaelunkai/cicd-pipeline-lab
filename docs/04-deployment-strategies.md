# Module 4 — Deployment Strategies

> Goal: know the ways code replaces code in production — and when each one is
> the right trade-off between speed, safety, and cost.

## 4.1 The question every strategy answers

You have version N running and version N+1 ready. How do you swap them
without an outage window, and how fast can you get back to N if N+1 is bad?
The strategies differ in **blast radius** (how much of the fleet sees the new
version at once) and **rollback cost** (work, time, or impossible).

## 4.2 The big four

### Rolling (default in Kubernetes Deployments)
Replace instances a few at a time until the whole fleet runs N+1.
- ✅ no idle capacity needed, gradual.
- ❌ N and N+1 serve traffic **at the same time** (must be compatible);
  rollback = roll backwards through the same slow path.

### Blue/Green (aka red/black)
Run two complete environments. Blue = live. Deploy N+1 to Green, test it with
real-shaped traffic, then flip the router in one step.
- ✅ instant switch, instant switch-back, testable before the flip.
- ❌ double the infrastructure; database schema changes need forward
  compatibility (the old Blue must survive while Green runs).

### Canary
Ship N+1 to 1% of traffic. Watch error rates and latency. 1% → 5% → 25% →
100%. Bail at any step by routing back.
- ✅ smallest possible blast radius; real-user signal before full exposure.
- ❌ needs traffic splitting + good monitoring; "1% of users" must be a
  representative sample, not "the unlucky".

### Feature flags (release ≠ deploy)
Deploy code with new behavior **off**, enable per-user/per-cohort at runtime.
- ✅ decouples deployment from release; instant kill-switch without rollback;
  the escape hatch for long-running migrations.
- ❌ flag debt — every flag needs a death date; combinations of flags are a
  test matrix that grows exponentially.

## 4.3 Rollback — the strategy this lab implements

The lab's environments are blue/green in miniature, with the artifact store
playing both standby copies:

```
deploy v1.0.0 ──▶ deploy v1.1.0 ──▶ something's wrong
                                        │
                 ◀─────────────────────┘
rollback prod: re-extract artifacts/taskflow-1.0.0.zip,
               smoke-test it, record the rollback in history.json
```

Watch it happen:

```bash
node pipeline.mjs --yes               # everything green at v1.0.0
# bump "version" in app/package.json to 1.1.0
node pipeline.mjs --yes               # everything green at v1.1.0
node pipeline.mjs rollback prod       # prod only: back to 1.0.0 in <1s
node pipeline.mjs status              # the mixed-version reality
```

The two habits this models:

1. **Rollback is a first-class pipeline operation**, not an emergency
   procedure someone improvises at 3 AM.
2. **You roll back the artifact, never the source.** `git revert` + rebuild
   produces *new* bytes; re-extracting the old zip reproduces *the exact
   bytes that were last known good*.

## 4.4 Choosing in practice

| Situation | Reach for |
|---|---|
| Stateless web service, cheap infra | rolling |
| You need near-zero downtime and instant reversal | blue/green |
| Risky change, strong metrics, real traffic to learn from | canary |
| Long migration, want deploy separate from release | feature flags |
| Everything non-trivial in production | flags **plus** one of the above |

Real systems layer them: canary the deployment *while* the feature sits
behind a flag, with a blue/green database cutover underneath.

## 4.5 Databases — where strategies go to die

Application instances are stateless and swappable; schema and data are not.
The rule that keeps every strategy above viable:

> **Expand → migrate → contract.** Add the new schema (expand), dual-write /
> backfill (migrate), remove the old schema only after no code reads it
> (contract) — each step independently deployable and reversible.

A blue/green flip with a breaking `DROP COLUMN` in it is how outages happen.

## Exercises

1. Run the rollback demo above. Read `environments/prod/history.json` — the
   `rollback` entry is your incident log line.
2. Try `node pipeline.mjs rollback staging` right after a first deploy: it
   refuses, because there is no previous version. A rollback path you never
   rehearsed is a rollback you don't have.
3. Sketch (no code needed) how `deploy.mjs` would change for a canary:
   the environment would need a `weights` file and the smoke test would need
   to target the canary copy.
