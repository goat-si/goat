# wp6 plan amendment (architect: Zeno, gpt-6.1-sol)

Amends 000_plan.md. Where they conflict, this file wins.

## 1. goat-ci.yml triggers

Change only the branch lists of the audited handoff/goat-ci.yml. Every other byte stays identical (matrix, commands, runner labels, concurrency, permissions, artifact retention).

```diff
 on:
   push:
-    branches: [main, "goat/**"]
+    branches: [main, dev, preview, "goat/**"]
   pull_request:
-    branches: [main]
+    branches: [main, dev, preview, "goat/**"]
   workflow_dispatch:
```

PR filters match the target branch. 000_plan.md omitted preview from PR targets; this corrects it.

## 2. Structural workflow validator

Replace the hook's unconditional goat-ci.yml exemption with tracked `.vite-hooks/goat-workflow-guard.mjs`.

The POSIX hook keeps remote selection, the explicit bypass, disabled-workflow lookup, and ref traversal. Deletion records are skipped before any dependency check; workflow states are fetched lazily, once, at the first non-deletion ref. Git traversal failures are rejected explicitly (no failure hidden inside command substitution). Every pushed tip is validated, including tips where the workflow did not change. For each tip containing goat-ci.yml:

```sh
if ! node "$root/.vite-hooks/goat-workflow-guard.mjs" "$local_sha" "$local_ref"; then
  status=1
fi
```

The validator reads the committed file with `execFileSync("git", ["show", sha + ":.github/workflows/goat-ci.yml"])`. It never uses a shell and never reads the working tree.

YAML loads from the repository's `node_modules/.pnpm/yaml@2.*/node_modules/yaml`, version checked as 2.*, loaded via createRequire on the absolute entry; deterministic choice if several exist. No download, global parser or regex fallback. Parse one YAML 1.2 document with unique keys, merge disabled, bounded alias expansion.

Rules:

- root and `on` are mappings; `on` is nonempty with keys only from {push, pull_request, workflow_dispatch}
- `jobs` contains exactly `ci`, which is a mapping
- job-level `uses`, `container`, `services` are rejected even when null
- `runs-on` is an array of exactly five distinct literal strings equal as a set to {self-hosted, linux, x64, goat, epyc}; order is free
- `steps` is a nonempty array of mappings; each step has exactly one of run/uses; every uses is exactly one of actions/checkout@v6, voidzero-dev/setup-vp@v1, actions/upload-artifact@v4

All refusals exit 1. Messages:

```text
goat pre-push: node is unavailable; refusing to push
goat pre-push: repository yaml@2.* is unavailable or unloadable; run vp i; refusing to push
goat pre-push: .github/workflows/goat-ci.yml in <ref> (<sha>): <reason>; refusing to push
```

Reasons: cannot read pushed workflow / invalid YAML / root must be a mapping / on must be a nonempty mapping containing only push, pull_request, workflow_dispatch / jobs must contain exactly ci / jobs.ci must be a mapping / jobs.ci.uses is forbidden / jobs.ci.container and jobs.ci.services are forbidden / jobs.ci.runs-on must contain exactly self-hosted, linux, x64, goat, epyc / jobs.ci.steps must be a nonempty array of mappings / step <index> must contain exactly one of run or uses / step <index>.uses is not an allowed action.

The audited GitHub lookup and unregistered-workflow messages and the bypass warning stay. The hook is an early warning only: --no-verify, hook shim disable variables, and other push clients bypass it. The real control is "every non-goat workflow disabled" on GitHub.

## 3. Tests

`scripts/goat-workflow-guard.test.ts`, run from repo root: `vp test run scripts/goat-workflow-guard.test.ts`.

Temp git repos with real committed tips, copied hook + validator, the real yaml package placed under a fixture .pnpm layout, a mock gh first on PATH, real pre-push records fed to /bin/sh -e. Assert exit status, diagnostics and mock call counts.

- Allow: valid goat-ci + disabled upstream; deletion-only push with no node/yaml/gh; non-goat remote; GOAT_SKIP_WORKFLOW_GUARD=1; reordered labels.
- Reject: unregistered workflow; gh failure; one bad tip among valid tips; hosted runner; reusable job; disallowed action; extra job; schedule; container/services; duplicate or missing labels; malformed or duplicate-key YAML; missing node; missing yaml; unreadable tip; clean working tree with bad committed tip.

goat-ci only runs build-desktop-artifact.test.ts under scripts/. This guard test is a separate local source gate; adding it to CI would be a separate workflow amendment.

## 4. Rollout gates and order

Before enabling Actions: fresh full workflow-state snapshot, every non-goat workflow disabled, all pushed tips checked, both runners (goat-epyc-01, goat-epyc-02) online with the five labels.

Branch flow: work on goat/epyc-ci; integrate into dev, then main/preview only under the parent's authorized branch flow. Never goat/global-agent.

EPYC prep preflights the tarball, ghrunner, both target dirs and build prerequisites before mutating anything. Each registration uses its own fresh token via stdin. svc.sh install/start runs from each runner dir. Verify the effective service HOME and isolated caches. Inspect host-wide slot/capacity policy (CI_SLOTS from earlier NeuralArcade work) before adding runners; do not change the four thingsflow services.

Completion evidence: focused tests pass; workflow body unchanged apart from triggers; four successful matrix jobs at the exact pushed SHA; runner ids and names; goat-desktop-build artifact contents with 3-day retention; zero jobs on hosted runners; upstream workflows still disabled. ChatView stays verified against ef4748eb7; no replacement helper.

## 5. Architect reflection (folded in)

- Correction to section 2: disabling upstream workflows protects only upstream workflows. A push that bypasses the hook can still change goat-ci.yml to hosted runners; there is no final enforcement layer. The hook is the only automated check on goat-ci.yml content.
- pull_request on "goat/**" means PRs that target goat branches. Kept intentionally; push already covers goat feature branches.
- yaml@2.9.0 API: `parseDocument(source, {version: "1.2", uniqueKeys: true, merge: false})`, then `doc.toJS({maxAliasCount: 100})`. merge:false keeps `<<` as ordinary data, so the validator must reject any `<<` key anywhere in the AST (reason: invalid YAML). It must also reject a document whose resulting version is not 1.2, because a `%YAML 1.1` directive overrides the requested default. Both get regression tests.
- EPYC slot policy (inspected 2026-10-11, read-only): the four thingsflow runners set ACTIONS_RUNNER_HOOK_JOB_STARTED/COMPLETED and CI_SLOTS=4 in their own .env, sharing /var/lib/cicd-ssot/slots. Those hooks are per-runner .env entries, and epyc-prepare.sh writes a fresh goat .env with only HOME and LANG, so goat runners do not inherit them. Decision: goat runners stay outside the thingsflow semaphore; goat concurrency is capped at 2 by runner count. Host: 192 threads, ~238 GiB available. No CI_SLOTS change, no change to thingsflow services.
- handoff/epyc-prepare.sh installs libsecret-1-dev before checking target dirs. B must produce `handoff/epyc-prepare.v2.sh` that preflights tarball, ghrunner user, absence of both goat dirs, apt availability, then mutates. The audited v1 stays as a record.
