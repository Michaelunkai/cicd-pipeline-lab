# Module 3 — DevOps Culture and DORA Metrics

> Goal: understand DevOps as an organizational and measurement discipline —
> not a job title, not a tool, and definitely not just "the person who runs
> the pipeline".

## 3.1 DevOps is what CI/CD makes possible

CI/CD is the machinery; DevOps is the operating philosophy around it. The
name points at the historical wall between **Dev** (ship changes) and **Ops**
(keep it stable) — two groups optimized against each other. DevOps removes
the wall by making the people who build a service responsible for running it,
and giving them automation so that responsibility is survivable.

## 3.2 CALMS — the five-letter model

| Letter | Meaning | In this lab |
|---|---|---|
| **C**ulture | blameless, shared ownership of outcomes | the run report records *what* failed, never *who* to blame |
| **A**utomation | automate everything repeatable | 8 stages, 1 human decision (the gate) |
| **L**ean | small batches, limit work in progress | every stage is small; the whole run is ~0.5s |
| **M**easurement | decisions from data, not vibes | durations, attempts, artifacts, verdicts in every run report |
| **S**haring | knowledge flows both directions | docs + readable source are the product, not a side effect |

## 3.3 The DevOps lifecycle

The classic infinite loop — plan, code, build, test, release, deploy,
operate, monitor — with **feedback flowing backwards at every arrow**. Two
arrows people forget:

- **monitor → plan**: production telemetry decides what gets built next.
- **operate → code**: an incident's lessons become a new pipeline stage or
  test. (Example: this lab's secret scanner is what you build *after* someone
  almost commits a token.)

## 3.4 DORA — the four key metrics

The DevOps Research and Assessment program measured thousands of teams and
found four metrics that separate elite performers from everyone else. Every
one of them is computable from this lab's run reports:

| Metric | Definition | Where it lives here |
|---|---|---|
| **Deployment frequency** | how often you release to production | count `deploy` entries in `environments/*/history.json` per day |
| **Lead time for changes** | commit → running in production | compare commit time with `manifest.json` `deployedAt` |
| **Change failure rate** | % of deploys causing incidents/rollbacks | count `type: "rollback"` vs `type: "deploy"` in history |
| **MTTR** (time to restore) | incident → healthy service | rollback duration: seconds here, because it re-extracts a known-good artifact |

The punchline of the DORA data: **elite teams deploy more often AND fail
less**. Frequency and stability are not a trade-off — small, automated,
gated batches give you both. That's the entire argument for this pipeline.

## 3.5 Shift-left

"Shift left" means moving quality checks earlier on the timeline (towards the
left of a left-to-right pipeline diagram). Concretely, in the order they bite:

1. Editor diagnostics — before you save.
2. `lint` — seconds after saving, before any human reviews.
3. `test` — before merge.
4. `scan` — before the artifact exists for deployment.
5. Smoke test after deploy — before users see it.
6. Production monitoring — the safety net, not the first line of defense.

Every check in this lab sits as far left as it can: the secret scan runs
*before* packaging, the deploy smoke test runs *before* the stage reports
success.

## 3.6 SRE and error budgets

Google's Site Reliability Engineering extends DevOps for systems too big to
babysit. Core ideas worth knowing:

- **SLO / SLI / error budget** — pick a reliability target (say 99.9% of
  requests succeed in <300 ms over 30 days); the remaining 0.1% is a budget.
  Budget left over → ship features faster. Budget burned → freeze features,
  work on reliability. This turns the dev-vs-stability argument into
  arithmetic.
- **Blameless postmortems** — incidents are systems failing, not people
  failing; the written postmortem feeds back into the pipeline.
- **Toil budget** — if a human does the same manual task often, automate it;
  that's how this repo's `rollback` came to exist.

## 3.7 Conway's law, reversed

Organizations design systems that mirror their communication structure. A
team split Dev/Ops will build a system where deploys are painful handoffs —
the structure *causes* the pain. Changing the structure (shared ownership,
you-build-it-you-run-it) changes what gets built. Choosing CI/CD first is
often the reverse move: adopt the tool, let the practice drag the culture.

## Exercises

1. Compute this lab's change failure rate: run a good deploy, then break a
   test, then run again — count green vs failed runs in `.pipeline/runs/`.
2. Measure MTTR: time `node pipeline.mjs rollback prod` — that's a restore.
3. Add a `monitor` stage to `pipeline.json` that reads `environments/prod/
   manifest.json` and asserts the deployed version matches the artifact's
   sha256 — you've just closed the operate→code feedback loop.
