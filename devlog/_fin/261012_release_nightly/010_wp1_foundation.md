# 010 — wp1 foundation: version, release repository, installers, version check, guard, notices

Prerequisite for wp2/wp3: every consumer must already point at goat-si/goat-releases and the version must already be 0.1.0 before a pipeline can publish anything. Re-verify anchors at the start of the cycle (base `32f7bda9b`).

## Changes

### 1. Version 0.1.0 (MODIFY ×4)

`apps/desktop/package.json:3`, `apps/server/package.json:3`, `apps/web/package.json:3`, `packages/contracts/package.json:3`

```diff
-  "version": "0.0.45",
+  "version": "0.1.0",
```

Then search tests/fixtures that assert the current package version by value (`rg -n '0\.0\.45' --glob '!.repos' --glob '!node_modules' --glob '!devlog'`) and update only those that read the package version (not fixtures that model an old remote runtime, e.g. legacy 0.0.45 SSH cases).

### 2. Nightly resolver: no patch bump, GOAT name (MODIFY)

`scripts/resolve-nightly-release.ts`

```diff
 export const resolveNightlyTargetVersion = (version: string) => {
   const stableCore = resolveNightlyBaseVersion(version);
   const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stableCore);
   if (!match) {
     return Effect.fail(new InvalidDesktopPackageVersionError({ version }));
   }
-
-  const [, major, minor, patch] = match;
-  return Effect.succeed(`${major}.${minor}.${Number(patch) + 1}`);
+  // GOAT nightlies are prereleases of the version in apps/desktop/package.json
+  // (0.1.0 -> 0.1.0-nightly.YYYYMMDD.N); cutting a stable release bumps the file.
+  return Effect.succeed(stableCore);
 };
...
-    name: `T3 Code ${CHANNEL_RELEASE_LABELS[channel]} ${version} (${shortSha})`,
+    name: `GOAT ${CHANNEL_RELEASE_LABELS[channel]} ${version} (${shortSha})`,
```

`scripts/resolve-nightly-release.test.ts:24-30`: rename test to "keeps the stable core as the nightly target", expect `0.0.17`, `9.9.9`, `1.2.3`; update any name assertion to `GOAT Nightly`. `scripts/release-smoke.ts:273-287`: expect `9.9.9-nightly.20260413.321`, tag `v9.9.9-…`, name `GOAT Nightly 9.9.9-nightly.20260413.321 (abcdef123456)` (fixture base is 9.9.9; confirm at cycle start).

### 3. Version check (NEW) + goat-ci step (MODIFY)

`scripts/check-release-version.ts` (NEW): exports `checkReleaseVersions(input: { versions: Record<string,string> }): string[]` (returns problems) and a CLI that reads the four package.json files. Problems: versions differ; version is not plain `x.y.z` (no prerelease in source); version < 0.1.0 (`compareSemverVersions` from `packages/shared/src/semver.ts`); the nightly derived via `resolveNightlyReleaseMetadata(resolveNightlyTargetVersion(v), "20261012", 1, "0123456789ab")` fails any consumer rule: desktop channel (`resolveDesktopUpdateChannel` in build-desktop-artifact.ts → "nightly"), CLI channel (`cliReleaseChannelOf` → "nightly"), CLI tag pick (`newestCliReleaseVersion([{tag_name: tag}], "nightly") === version`), and is greater than `0.0.45-nightly.20261011.3`. Exit 1 with one line per problem.
`scripts/check-release-version.test.ts` (NEW): passing case, mismatch, `0.0.45` (too low), `0.1.0-beta.1` (prerelease in source).
`.github/workflows/goat-ci.yml`, test task: add a separate step `run: node scripts/check-release-version.ts` (repository root; the existing "Test build scripts" step keeps its `working-directory: scripts`) and add `check-release-version.test.ts resolve-nightly-release.test.ts goat-workflow-guard.test.ts` to the "Test build scripts" `vp test run` list. (Allowed by the guard: plain `run` steps.)

### 4. Release repository constants (MODIFY)

- `packages/shared/src/cliRelease.ts:8`: `CLI_RELEASE_REPOSITORY = "goat-si/goat-releases"`. Update its tests and every fixture that embeds generated URLs: `packages/ssh/src/fixtures/remote-runner-baseline.json` (regenerate or edit URLs), `apps/web/src/components/desktopUpdate.toast.test.tsx:76`, `apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx:90` (find by `rg -n 'goat-si/goat/' --glob '!.repos'`).
- `scripts/build-desktop-artifact.ts:65`: `DESKTOP_UPDATE_REPOSITORY = "goat-si/goat-releases"`; test `scripts/build-desktop-artifact.test.ts` (~:391, :501-513).
- `packages/ssh/src/tunnel.ts:1862` message: replace literal `goat-si/goat release` with `${CLI_RELEASE_REPOSITORY} release` (import from `@t3tools/shared/cliRelease`).
- `scripts/build-npm-platform-packages.ts:213`: URL → `https://github.com/goat-si/goat-releases/releases`.
- `apps/marketing/src/lib/releases.ts:1`: `REPO = "goat-si/goat-releases"`; `apps/marketing/src/pages/index.astro:65,408`: `https://github.com/goat-si/goat-releases/releases`. `apps/marketing/src/lib/site.ts:1` stays (it is the upstream source link and attribution).
- Web release-notes links derive from `CLI_RELEASE_REPOSITORY` (`desktopUpdate.logic.ts:6-7`): no edit.

### 5. Installers (MODIFY)

`scripts/install.sh`: `repo="goat-si/goat-releases"`; `channel="${T3CODE_CHANNEL:-nightly}"` with a comment "GOAT ships nightlies only until the latest channel opens"; failure message `could not find a ${channel} release (GitHub API limit or network); set T3CODE_VERSION=<version>`. Same in `scripts/install.ps1` (`$repo`, default `"nightly"`, message). The release-list fetch retries transient failures (`curl --retry 3 --retry-all-errors --retry-delay 2`; PowerShell loop of 3 attempts with backoff) — anonymous listing is limited to 60 requests/hour/IP. Update `scripts/install.test.ts` / `scripts/install-windows.test.ts` expectations that encode the default channel or repository. Header usage comments mention `T3CODE_CHANNEL=stable` for later.

### 6. License and notices in artifacts (MODIFY)

- `scripts/build-desktop-artifact.ts` extraResources (~:2886): add `{ from: <repo>/LICENSE, to: "LICENSE-T3CODE.txt" }` for all platforms (keep the existing `.deb` LICENSE install).
- `scripts/build-cli-archive.ts` staging (~:509): copy `LICENSE` to `<content>/LICENSE-T3CODE.txt`. The web client's `third-party-licenses.json` already travels inside both (L3 §4).
- `scripts/lib/release-notices.ts` (NEW): `renderThirdPartyNotices(json): string` turns `third-party-licenses.json` into `THIRD_PARTY_NOTICES.md` (package, version, license, notice text). Used by wp2 assemble/publish. Test with a two-package fixture.

### 7. Pre-push guard accepts goat-nightly.yml (MODIFY, N-4; audit r1 blocker 4)

`.vite-hooks/goat-workflow-guard.mjs`: keep the goat-ci validator; add `validateNightlyWorkflow(workflow)` for `.github/workflows/goat-nightly.yml`, using the same safe YAML load. A pushed workflow path is accepted if it is disabled on GitHub, or is goat-ci.yml and valid, or is goat-nightly.yml and valid. Nightly rules:

1. `on` keys are exactly ⊆ {`workflow_run`, `workflow_dispatch`} and include `workflow_run` with `workflows: [goat-ci]`, `types: [completed]`, `branches: [dev]`.
2. Top-level `permissions` is `{contents: read}`; no job widens `contents` beyond read.
3. A job named `prepare` exists whose `if` (whitespace-normalized) equals the canonical gate in 020 §1, and it always sets output `skip` to `'true'` or `'false'`. Every other job lists `prepare` in `needs` directly, and its `if` (whitespace-normalized) is either exactly `needs.prepare.result == 'success' && needs.prepare.outputs.skip == 'false'` or that text followed by ` && (` + rest + `)` with balanced parentheses in rest. Because `&&` binds tighter than `||`, no `always()`, `||` or status function inside rest can run the job unless prepare succeeded and did not skip (GitHub: a status function in `if` replaces the implicit `success()`, so the explicit `needs.prepare.result` term is what holds).
4. Every job: no `uses`, `container`, `services`; `runs-on` is one of the allowed hosted strings (`ubuntu-24.04`, `ubuntu-24.04-arm`, `windows-2025`, `windows-11-arm`), the EPYC label set, the Mac label set `[self-hosted, macOS, ARM64, goat, mac-studio]`, or `${{ matrix.runner }}` where every `strategy.matrix.include[*].runner` is itself allowed (string or array).
5. Steps: exactly one of `run`/`uses`; `uses` ∈ {`actions/checkout@v6`, `voidzero-dev/setup-vp@v1`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `actions/create-github-app-token@v2`, `dtolnay/rust-toolchain@stable`}.
6. Secrets and App tokens: the text `secrets.` and the action `actions/create-github-app-token` may appear only in the job named `publish`, whose `runs-on` must be `ubuntu-24.04`. (`github.token` is allowed anywhere; it is read-only here.)
7. Every `actions/checkout` step has `with.ref` equal to `${{ needs.prepare.outputs.sha }}` (or `${{ steps.resolve.outputs.sha }}` inside prepare) and `persist-credentials: false`.
   Tests in `scripts/goat-workflow-guard.test.ts` (same fixture style): accepts a minimal valid nightly; refuses `pull_request`/`push` triggers, a missing or altered gate, a job without `needs: prepare`, a downstream job with `if: always()` or `if: needs.prepare.result == 'success' || always()` or no `if`, an unknown runner set, a matrix with one bad runner, a disallowed action, `secrets.` in a Mac job, the token action outside publish, publish on a self-hosted runner, a checkout without the verified ref.
   The guard runs in the pre-push hook and is advisory (bypassable with `GOAT_SKIP_WORKFLOW_GUARD=1` or `--no-verify`); 020 §1 lists the GitHub-side settings that enforce the boundary.

## Proof

`vp test run scripts/resolve-nightly-release.test.ts scripts/check-release-version.test.ts scripts/goat-workflow-guard.test.ts scripts/build-desktop-artifact.test.ts scripts/install.test.ts scripts/install-windows.test.ts scripts/lib/release-notices.test.ts packages/shared/src/cliRelease.test.ts <touched web/ssh tests>`; `node scripts/check-release-version.ts` exit 0; `node scripts/resolve-nightly-release.ts --date 20261012 --run-number 1 --sha 0123456789abcdef` prints `version=0.1.0-nightly.20261012.1`; `node scripts/release-smoke.ts` if it runs offline; targeted typecheck for scripts, shared, web, ssh.
