# Module 5 — Security in the Pipeline (shift-left security)

> Goal: put the standard security checkpoints *inside* the pipeline, where
> they block bad releases automatically — and understand why "we scan later"
> means "we scan never".

## 5.1 The pipeline is a policy engine

Every stage is a rule with teeth: "a change that does X does not ship."
Security in CI/CD means choosing the right X's and giving them teeth. The
checkpoint ladder, earliest first:

| Checkpoint | Catches | In this lab |
|---|---|---|
| Secret scanning | leaked credentials | `scan` stage — `tools/scan.mjs` |
| SAST / lint rules | dangerous patterns | `lint` stage (eval, debugger) |
| Dependency audit | known-vulnerable packages | (zero deps here — see 5.4) |
| SBOM / provenance | unknown contents in artifacts | `dist/manifest.json` hashes |
| Smoke test post-deploy | broken deployments | `deploy.mjs` smoke check |
| Runtime monitoring | attacks and regressions | module 3's `monitor` exercise |

## 5.2 Secret scanning — read the implementation

`tools/scan.mjs` is a real (small) secrets scanner:

- **Known shapes**: AWS access keys (`AKIA…`), GitHub tokens (`ghp_…`),
  private key blocks, generic `api_key = "…"` assignments, bearer strings.
- **Where it looks**: source, tests, tools, **build output**, and CI workflow
  files — because a secret in source *propagates into bundles* (the scanner
  finds `app/src/taskflow.mjs` AND `dist/taskflow.mjs`).
- **What it does on a hit**: exits non-zero → the pipeline is blocked, the
  artifact is never packaged, the deploy never happens.

Try it (then undo it):

```bash
echo "const backup = 'AKIAABCDEFGHIJKLMNOP';" >> app/src/taskflow.mjs
node pipeline.mjs --yes    # scan fails, everything downstream skipped
# undo the edit, rerun — green
```

Two facts that explain the severity:

1. **Git remembers everything.** Removing a secret in the next commit does
   not remove it from history; the scanner exists to stop the *first* commit.
2. **CI logs are read by more people than code.** A token echoed in a log is
   compromised the moment the log renders — hence `maskSecrets()` in the
   engine (module 2.5).

## 5.3 Least privilege for pipeline credentials

The pipeline itself holds credentials (to deploy, to publish). Rules:

- One identity per pipeline, **scoped to exactly what it deploys** — never a
  personal admin token, never a account-wide key.
- Injected by the CI system's secret store (GitHub *Actions secrets*, GitLab
  *masked variables*, Azure *variable groups*) — reaching the stage as an
  environment variable, which is why the engine's masking hook exists at the
  exact boundary where output is produced.
- Rotatable without ceremony: if rotating a deploy token is scary, it is too
  privileged.

This lab models the shape: `TASKFLOW_DEPLOY_TOKEN` arrives as an environment
variable, is used by `deploy.mjs`, and is never echoed.

## 5.4 Supply chain: dependencies, SBOM, provenance

You ship your code *plus* everything it imports. The modern defenses:

- **Lockfiles + audit**: commit the lockfile; let the pipeline run
  `npm audit` / `osv-scanner` against it. This repo's radical alternative is
  itself the lesson: **zero runtime dependencies** means the dependency attack
  surface is zero. That's not always practical — but knowing *why* it's
  secure here makes the trade-off visible everywhere else.
- **SBOM** (software bill of materials): a machine-readable list of what's
  inside the artifact. This lab's `dist/manifest.json` is a miniature SBOM —
  every file with size and sha256. When the next `log4shell` lands, the
  question "are we shipping it?" is answered by grep, not archaeology.
- **Provenance**: signed attestations of *how* the artifact was built
  (SLSA levels, sigstore/cosign). The lab's version: the artifact's sha256
  is recorded in the run report **and** in every environment manifest —
  a chain from commit → build → artifact → environment you can verify with
  `sha256sum`.

## 5.5 The deployment surface itself

CI/CD systems are high-value targets (they hold the keys to production):

- Protect the default branch + require the checks you mean it (this repo's
  `ci.yml` is the required check GitHub will enforce).
- Pin third-party actions by full commit SHA, not floating tags.
- Ephemeral runners/token scopes beat long-lived credentials on bare metal.

## Exercises

1. Add a new pattern to `tools/scan.mjs` — Slack tokens (`xoxb-…`) — and
   prove it with a temp fixture (build the string at runtime, like
   `engine-tests` does).
2. Verify the provenance chain by hand: compare `sha256` in
   `environments/prod/manifest.json` against the artifact in `artifacts/`
   and the `package` line of the matching run report in `.pipeline/runs/`.
3. Explain in one sentence why the scanner checks `dist/` when source is
   already covered. (Answer: build steps copy, transform and *bundle* —
   scanning only source assumes the build adds nothing.)
