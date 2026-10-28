# Module 6 — GitOps, Monitoring, and taking this to the real world

> Goal: graduate from the lab to production patterns: GitOps, observability,
> containers, and mapping every part of this repo onto a real stack.

## 6.1 GitOps — Git as the source of truth for operations

The pattern this lab previews with `environments/*/manifest.json`: the
desired state of every environment is *declared*, versioned, and diffable.
GitOps formalizes it:

> The desired state lives in Git. An agent in the cluster **continuously
> reconciles** reality against it. Change reality by changing Git — including
> rollbacks, which are `git revert` of the environment repo.

- **Push GitOps**: CI deploys what Git says (this lab's shape: the pipeline
  *pushes* artifacts into environments and writes a manifest).
- **Pull GitOps**: the cluster itself pulls its desired state (Argo CD,
  Flux). Pull wins on security — no cluster credentials in CI — and on
  self-healing: drift is reverted automatically.

Where this lab maps:

| Lab artifact | GitOps equivalent |
|---|---|
| `pipeline.json` | Kustomize overlays / Helm values per environment |
| `environments/prod/manifest.json` | the rendered state Argo CD shows for prod |
| `history.json` | Aro CD / Flux sync history |
| `rollback prod` | `git revert` in the env repo (reconciler does the rest) |

## 6.2 Observability — the pipeline's eyes after deploy

A deploy stage that ends green has only *begun* to prove itself. The three
pillars, plus the questions they answer:

- **Logs** — what happened? (structured, correlated by trace id)
- **Metrics** — how is it behaving? (rate, errors, duration — the RED set)
- **Traces** — where did time go across services?

The pipeline's job is to make signal **routable to action**: alerts page a
human only when a deploy's smoke test fails or error budget burns. This lab's
smoke check (`deploy.mjs`) is the smallest possible observability loop: probe
→ compare → verdict, executed automatically on every deploy.

## 6.3 Containers and image pipelines

The same DAG, retargeted at images:

```
test ──▶ docker build ──▶ scan image ──▶ push registry (tag = git sha) ──▶ deploy
```

Non-negotiables this lab taught, in image form:

- The image tag is the **artifact** — immutable, sha-addressed (our zip's
  sha256 discipline = image digests, not `:latest`).
- Scan the **artifact**, not just the source (`scan` checks `dist/` →
  `trivy image` after build).
- Deploy = point the environment at a digest; rollback = point it back
  (exactly `rollback prod`, minus the folder).

## 6.4 A tour of real engines (what to learn next)

| System | Shape | Learn it when |
|---|---|---|
| **GitHub Actions** | YAML workflows, marketplace, OIDC to cloud | your code is on GitHub (this repo: `.github/workflows/`) |
| **GitLab CI** | `.gitlab-ci.yml`, runner autoscaling, built-in registry/environments | you want one platform for repo+registry+CD |
| **Jenkins** | Groovy pipelines, plugins, self-hosted fleet | maintaining legacy enterprise pipelines |
| **Azure DevOps** | YAML + classic, environments with approvals, boards | Microsoft-stack enterprises |
| **Argo CD / Flux** | pull-based GitOps controllers | Kubernetes is your deployment target |
| **Tekton / Dagger** | pipelines as code (containers/buildkit) | you want pipelines that are testable programs |

## 6.5 Study map for this repo

Everything you just read is implemented in ~1000 readable lines:

```
pipeline.mjs            stages 1–2: DAG, gates, masking, reports
tools/lint.mjs          stage 2.7: quality gate
tools/build.mjs         stages 2.3/5.4: bundle + SBOM-lite manifest
tools/scan.mjs          stage 5: shift-left secret scanning
tools/package.mjs       stage 2.3: immutable, versioned artifact
tools/deploy.mjs        stages 2.3/4.3: promotion, smoke tests, rollback
tools/zip.mjs           artifact format, CRC32 integrity
engine-tests/           the pipeline under test — read these as specs
.github/workflows/      the same pipeline, running for real on GitHub
```

## 6.6 A 30-day self-curriculum

1. **Days 1–5** — run this lab top to bottom; do every exercise in modules
   1–2. Break things on purpose.
2. **Days 6–12** — take a real project of yours; add lint+test to GitHub
   Actions with a required check on main. Feel branch protection bite.
3. **Days 13–20** — add an artifact (zip/image) + a deploy to a disposable
   environment (a branch-named cloud preview). Implement one approval gate.
4. **Days 21–25** — add a secret scanner + dependency audit as blocking
   stages. Rotate one real secret while you're at it.
5. **Days 26–30** — add rollback rehearsed end-to-end (scripted, timed), and
   a post-deploy smoke/health check. Compute your four DORA numbers.

When all five rows are true, you don't know *about* CI/CD — you *run* it.

## Final exercise

Extend this lab with a `monitor` stage that fails the run if
`environments/prod/manifest.json` references an artifact whose sha256 no
longer matches `artifacts/`. That single stage is GitOps reconciliation,
provenance verification, and observability — one `node` script.
