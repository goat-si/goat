# wp6 build record (phase B, including rework)

## Remote setup (2026-10-11 KST)

- 18 upstream workflows disabled via PUT .../workflows/{id}/disable; snapshots: evidence/workflows-after-disable.json, evidence/workflows-pre-enable.json (18/18 disabled_manually, same paths as workflows-before.json).
- EPYC: `sudo -n true` fails (no NOPASSWD); prepare.v2 installed only libsecret-1-dev, libgcrypt20-dev, libgpg-error-dev (dpkg.log), created /opt/actions-runner/goat-epyc-0{1,2}. thingsflow services stayed active throughout.
- Registered goat-epyc-01 (id 2) and goat-epyc-02 (id 3), labels self-hosted, Linux, X64, goat, epyc; toolchain smoke OK as ghrunner with runner HOME. Services actions.runner.goat-si-goat.goat-epyc-0{1,2} active, MainPID user ghrunner.
- Actions enabled (allowed_actions all) after the pre-enable gate.

## Commits on goat dev

- bfce4301d ci: run goat CI only on EPYC self-hosted runners
- cc5003979 fix(ci): goat pre-push guard matches remotes case-insensitively (C review: Goat-Si/Goat bypass, refs/replace)
- 4b68b2e8b test(scripts): goat workflow guard test passes scripts typecheck
- 1ea5118af test(web): T3 MCP timeline rows assert the goat mark

## Run 1 (38082452843 @ bfce4301d)

check success, build success, test failure, typecheck failure; all four jobs on goat-epyc-01/02.

- typecheck: scripts/goat-workflow-guard.test.ts lacked the repo's `// @effect-diagnostics nodeBuiltinImport:off` directive and had a TS2345. Our defect; fixed in 4b68b2e8b.
- test: MessagesTimeline "renders T3 MCP dynamic tools with the product logo" expected the old T3 wordmark viewBox. Pre-existing on goat dev since cc1ba0550 (goat branding), reproduces on macOS. Assertion updated to the goat mark (viewBox 92 92 1070 1070) in 1ea5118af; product code unchanged.
- Non-failing noise: StyledDiffCodeView worker-pool stderr is an expected fallback path in that test.
