# environments/ — the deployment targets

Each subfolder (`dev`, `staging`, `prod`) is a **simulated environment** — the
lab's stand-in for a real server, container platform, or cloud target.

```
environments/
├── dev/        fast lane: every green pipeline deploys here automatically
├── staging/    promotion behind an approval gate + smoke test
└── prod/       promotion behind a second approval gate + smoke test
```

After a deploy, each environment folder holds:

| File | Meaning |
|---|---|
| `app/` | the extracted artifact — exactly the bytes that were packaged |
| `manifest.json` | what version is "live", from which run, artifact sha256 |
| `history.json` | append-only deploy/rollback log — the audit trail |

Inspect them with `node pipeline.mjs status`, and turn back time with
`node pipeline.mjs rollback prod`.
