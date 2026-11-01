# wp6 check record (phase C)

Reviews (gpt-6.1-sol): Faraday FAIL on bfce4301d (case-sensitive remote match, refs/replace) -> fixed in cc5003979; Volta PASS on bfce4301d..1ea5118af at exact HEAD 1ea5118af.

Local gates at 1ea5118af: vp test run scripts/goat-workflow-guard.test.ts 76/76; (cd scripts && tsc --noEmit) 0 errors; MessagesTimeline.test.tsx 83/83; vp lint on touched files clean; git diff --check clean.

Hosted gate: goat-ci run 38083004166 @ 1ea5118af16a05fd1c3571e4736b6388c9da9e31, conclusion success.
https://github.com/goat-si/goat/actions/runs/38083004166

| job            | result  | runner       |
| -------------- | ------- | ------------ |
| goat-check     | success | goat-epyc-02 |
| goat-typecheck | success | goat-epyc-01 |
| goat-test      | success | goat-epyc-02 |
| goat-build     | success | goat-epyc-01 |

All jobs requested labels self-hosted,linux,x64,goat,epyc. Across both runs in the repo (2 total), all 8 jobs ran on goat-epyc-01/02; zero jobs on GitHub-hosted runners.

Artifact goat-desktop-build id 11681027714, 87,972,745 bytes, expires 2026-10-13T20:17:39Z (3 days). Downloaded contents: apps/desktop/dist-electron, apps/server/dist, apps/web/dist, native/browser-secret/build/x64/t3-browser-secret (ELF 64-bit x86-64).

Workflows after run (evidence/workflows-post-run.json): 1 active (.github/workflows/goat-ci.yml), 18 disabled_manually.

Runners: id 2 goat-epyc-01 online, id 3 goat-epyc-02 online. EPYC: 4 thingsflow + 2 goat runner services active; each goat .env has 2 lines with its own HOME=/opt/actions-runner/goat-epyc-0N/_home; Toolchain step confirmed HOME at run time. Disk / 4% used.

Earlier run 38082452843 @ bfce4301d failed (see 030_build.md); it is superseded, not hidden.

Limits: goat-ci tests only @t3tools/ssh, @t3tools/web and the desktop-artifact script test (narrower than upstream ci.yml). The pre-push hook is an early warning; --no-verify or other clients bypass it and nothing on GitHub enforces goat-ci.yml content.
