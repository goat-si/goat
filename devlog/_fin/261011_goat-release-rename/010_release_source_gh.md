# 010 — wp2: release source and authenticated SSH acquisition (D1–D4)

A cold SSH host receives the exact GOAT runtime from locally authenticated `gh`. Local acquisition verifies SHA256SUMS, atomically publishes a checksum sidecar before the archive, then uses the existing upload installer. Later cache hits verify present sidecars; local builds without sidecars stay trusted. Explicit mirrors retain remote downloads. Independent release consumers point at `goat-si/goat`, with D4's authentication limitation recorded.

## Loop spec

- Archetype: satisfy-spec, one parent-owned wp2 P→A→B→C→D after wp1 and before wp3. This bounded plan-writing leaf owns no FSM/loop/goal.
- Trigger: GOAT SSH dispatch looks for a GOAT version in upstream T3 releases and receives 404; user requested local `gh` with `goat-si/goat`.
- Goal: default SSH follows remote ready → local cache → authenticated gh → SHA-256 verification → atomic cache publication → upload. No gh error falls back to anonymous remote acquisition.
- Non-goals: MCP tool/provider rename, CLI/archive rename (wp4), remote state/home paths (decided D7-A, implemented in wp4), changing `T3CODE_*`, auth conversion for D4 consumers, live app/server changes, release publication/push/PR. This leaf performs no installs/builds/tests/servers/git mutations and writes only this file.
- Verifier: focused tests, targeted package typechecks, exact stale-name gates and conditional activation matrix below. All execution verifiers are **NOT RUN** because the packet forbids them; no exit code or implementation PASS is claimed. Parent obtains fresh execution evidence and independent review.
- Stop: leaf finishes after literal before-hunk/source validation and delivery of this plan. Parent closes wp2 only after focused proof and independent review pass or records the actual blocker.
- Memory artifact: existing `devlog/_fin/261011_goat-release-rename/` (000/001/010 and later parent evidence). No persistent memory-store update is authorized.
- Outcomes: PLAN_DELIVERED for leaf; parent may report VERIFIED, NEEDS_HUMAN or BLOCKED. These labels do not create new FSM/goal states.
- Escalation: source hunk drift, need to publish a release, remote live `~/.t3/userdata`, or parent decision on D2 clarifications below. No subagent spawn grant is available or used.

## Source grounding and amendments for parent

Initial writer read 000_plan.md and 001_inventory.md; this reflection amendment read 000_plan.md and 002_architect.md first, then actual files in `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename`. Every MODIFY before hunk below was generated from actual current bytes and its replacement anchor checked. These are proposed patches; none is applied to source. Revalidate at B because shared branch/HEAD may move.

- D2/D3: missing/blank archiveDirectory must not silently authorize default remote download. Probe readiness first; a cold host without a local cache directory fails clearly. A nonblank explicit mirror retains the existing no-cache path. Whitespace releaseBaseUrl does not count as a mirror.
- D2 amendment: `issueRemoteMcpClientSession` currently executes a cold runner without `prepareRemoteRuntime`. Include the same preparation call and add SshLaunchError to its declared error channel. This bounded integration is included below to close that acquisition bypass; parent should reflect it in D2 before implementation. It does not rename MCP tools.
- D1 inventory amendment: include desktop release-note URLs and AUR PKGBUILD asset/LICENSE URLs. Unrelated source/support/model-manifest links remain outside this phase.
- D2/D3: unsupported platform has no asset; fail explicitly rather than falling back, with diagnostic asset `unsupported-<platform>-<arch>`.
- A2: `<asset>.sha256` contains the exact verified `<sha256>  <asset>\n` entry. Both files are staged on the cache filesystem, then sidecar and archive are separately atomically renamed in that order. This is not a two-file transaction: an interrupted attempt may leave only a sidecar, which is retried because no archive exists. A present malformed/mismatched sidecar fails closed; no-sidecar local archives retain D9 behavior.
- A3: gh uses `GH_PROMPT_DISABLED=1`, ignored stdin, a 300,000 ms acquisition deadline and a 400-character sanitized stderr tail in the public error; no raw stdout/stderr is copied into the diagnostic cause. Server configuration forwards a trimmed nonblank `T3CODE_RELEASE_BASE_URL`, matching desktop main.ts:128–135's existing mirror option.
- A10: internal `RemoteT3RunnerOptions.ghCommand?: string` defaults to `"gh"` and is forwarded to the downloader. Resolve at spawn time using the environment already installed by desktop shell initialization; no eager PATH lookup, shell interpolation, persistent settings or wire field. Spawn-only PlatformError.reason._tag=NotFound (Node ENOENT) maps to the literal actionable `gh not found on PATH` error, rather than treating a missing filesystem checksum as missing gh.
- A13: a module-local keyed lock coalesces racing downloads of the same resolved cache path, re-reading the cache under the lock. The concrete test races two prepares, observes partial staging and each real filesystem rename, then asserts one complete archive, matching sidecar, two verified uploads and no staging residue. Lock wait is bounded by the same acquisition deadline; separate processes still use distinct staging and atomic individual renames, without a cross-process pair-transaction guarantee.

Architect consultation/reflection (`002_architect.md`) and A review remain parent-owned; this leaf does not assert they occurred. Three memory stores were searched selectively; no historical note supplied the release decisions. Current plan/source control this design.

## Ordered steps

1. Export CLI_RELEASE_REPOSITORY for GOAT and update URL assertions. Keep `t3-*` archive/executable names until wp4 changes producers and consumers together.
2. Add an internal SSH library effect that yields FileSystem/Path/ChildProcessSpawner and reuses the Crypto-backed local archive reader. No transport handler, runtime bridge, shell command interpolation or new auth service.
3. Integrate preparation for launch/pairing/cold MCP session. Existing SSH upload, install lock, digest verification and managed-runner reuse remain the execution paths.
4. Add fake-spawner behavior tests. Existing protocol-only tests use an explicit mirror, so they still test protocol parsing and timeout rather than accidentally invoking real gh.
5. Retarget independent URL copies and exact fixture strings. No blanket fixture regeneration or unrelated source rewrite.
6. Parent runs focused gates and obtains independent review; records D4 limitations and wp4 handoff. Do not run an installer/release script or touch a live host during wp2.

## File change map

Source root (R): `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename`. Every path below is exact relative to R; full absolute paths label the source hunk sections. NEW files have empty before state. DELETE: none.

| Path under R                                                       | Action |
| ------------------------------------------------------------------ | ------ |
| packages/shared/src/cliRelease.ts                                  | MODIFY |
| packages/shared/src/cliRelease.test.ts                             | MODIFY |
| packages/ssh/src/runtimeArchive.ts                                 | MODIFY |
| packages/ssh/src/runtimeArchiveGh.ts                               | NEW    |
| packages/ssh/src/runtimeArchiveGh.test.ts                          | NEW    |
| packages/ssh/src/tunnel.ts                                         | MODIFY |
| packages/ssh/src/tunnel.test.ts                                    | MODIFY |
| apps/server/src/sshRemote/SshRemoteDispatch.ts                     | MODIFY |
| apps/server/src/sshRemote/SshRemoteDispatch.test.ts                | MODIFY |
| packages/ssh/src/fixtures/remote-runner-baseline.json              | MODIFY |
| scripts/install.sh                                                 | MODIFY |
| scripts/install.ps1                                                | MODIFY |
| packaging/aur/scripts/release.sh                                   | MODIFY |
| packaging/aur/t3code-bin/PKGBUILD                                  | MODIFY |
| packaging/aur/t3code-nightly-bin/PKGBUILD                          | MODIFY |
| apps/marketing/src/lib/releases.ts                                 | MODIFY |
| scripts/build-npm-platform-packages.ts                             | MODIFY |
| scripts/build-npm-platform-packages.test.ts                        | MODIFY |
| apps/web/src/components/desktopUpdate.logic.ts                     | MODIFY |
| apps/web/src/components/desktopUpdate.logic.test.ts                | MODIFY |
| apps/web/src/components/desktopUpdate.toast.test.tsx               | MODIFY |
| apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx | MODIFY |

No wire fields/enums are added: creation/serialization/deserialization stages N/A. Existing archiveDirectory/releaseBaseUrl/archiveVersion builders are desktop `main.ts` and server `sshRemote/SshRemoteDispatch.ts`; the consumer is prepareRemoteRuntime. Tests inject the existing ChildProcessSpawner service. The internal ghCommand runner option is consumed only by local acquisition; it is never serialized into a remote shell runner or a wire request. The MCP error-channel widening flows through manager `SshEnvironmentEffectError`, which already contains SshLaunchError.

This is a library effect within the existing SshEnvironmentManager capability. Server transports remain thin; no new server service/handler is added. Follow actual `command.ts` subprocess concurrency/scope patterns and `runtimeArchive.ts` FileSystem/Crypto behavior. Vendored Effect FileSystem supports makeTempDirectoryScoped({directory,prefix}) and rename; ChildProcess.StandardCommand exposes command/args/options with shell=false.

## Exact source hunks

Apply in ordered step sequence, not necessarily section order. All removed lines are literal source; added lines are proposed, uncompiled implementation.

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared/src/cliRelease.ts` — MODIFY

```diff
--- a/packages/shared/src/cliRelease.ts
+++ b/packages/shared/src/cliRelease.ts
@@ -5,7 +5,7 @@
  * platform key, so a rename here is a release-breaking change.
  */

-const CLI_RELEASE_REPOSITORY = "pingdotgg/t3code";
+export const CLI_RELEASE_REPOSITORY = "goat-si/goat";
 export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
 /** Overrides the download origin for mirrors and air-gapped installs. */
 export const CLI_RELEASE_BASE_URL_ENV = "T3CODE_RELEASE_BASE_URL";
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared/src/cliRelease.test.ts` — MODIFY

```diff
--- a/packages/shared/src/cliRelease.test.ts
+++ b/packages/shared/src/cliRelease.test.ts
@@ -33,7 +33,7 @@

   it("resolves download URLs under the tagged release, honoring a mirror", () => {
     expect(cliReleaseDownloadBaseUrl("1.2.3")).toBe(
-      "https://github.com/pingdotgg/t3code/releases/download/v1.2.3",
+      "https://github.com/goat-si/goat/releases/download/v1.2.3",
     );
     expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/t3/")).toBe(
       "https://mirror.example/t3/v1.2.3",
@@ -87,7 +87,7 @@

   it("pages through the release index at the largest page GitHub allows", () => {
     expect(cliReleaseIndexPageUrl(1)).toBe(
-      "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=100&page=1",
+      "https://api.github.com/repos/goat-si/goat/releases?per_page=100&page=1",
     );
     expect(cliReleaseIndexPageUrl(3)).toContain("page=3");
   });
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/runtimeArchive.ts` — MODIFY (A2 cache-hit verification)

```diff
--- a/packages/ssh/src/runtimeArchive.ts
+++ b/packages/ssh/src/runtimeArchive.ts
@@ -1,4 +1,4 @@
-import { cliArchiveFileName, type CliArchivePlatformKey } from "@t3tools/shared/cliRelease";
+import { cliArchiveFileName, parseChecksums, type CliArchivePlatformKey } from "@t3tools/shared/cliRelease";
 import * as Crypto from "effect/Crypto";
 import * as Effect from "effect/Effect";
 import * as Hex from "effect/encoding/Hex";
@@ -39,5 +39,16 @@
     });
   }
   const sha256 = Hex.encode(yield* crypto.digest("SHA-256", bytes));
+  const sidecarPath = `${filePath}.sha256`;
+  if (yield* fs.exists(sidecarPath)) {
+    const expected = parseChecksums(yield* fs.readFileString(sidecarPath)).get(fileName);
+    if (expected === undefined || sha256 !== expected) {
+      return yield* new SshLaunchError({
+        message: `Cached SSH runtime archive SHA-256 mismatch or malformed sidecar (${filePath}). Remove or replace the invalid cache entry before retrying.`,
+        stdout: "",
+      });
+    }
+  }
+  // An archive without a sidecar remains a trusted user-supplied local build.
   return { fileName, bytes, sha256 };
 });
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/runtimeArchiveGh.ts` — NEW

Before: absent. After: complete module.

```diff
--- /dev/null
+++ b/packages/ssh/src/runtimeArchiveGh.ts
@@ -0,0 +1,145 @@
+import {
+  CLI_RELEASE_CHECKSUMS_FILE,
+  CLI_RELEASE_REPOSITORY,
+  cliArchiveFileName,
+  parseChecksums,
+  type CliArchivePlatformKey,
+} from "@t3tools/shared/cliRelease";
+import * as KeyedLock from "@t3tools/shared/KeyedLock";
+import * as Duration from "effect/Duration";
+import * as Effect from "effect/Effect";
+import * as FileSystem from "effect/FileSystem";
+import * as Option from "effect/Option";
+import * as Path from "effect/Path";
+import * as PlatformError from "effect/PlatformError";
+import * as Stream from "effect/Stream";
+import { ChildProcess, ChildProcessSpawner } from "effect/process";
+
+import { SshLaunchError } from "./errors.ts";
+import { readLocalRuntimeArchive } from "./runtimeArchive.ts";
+
+const GH_DOWNLOAD_TIMEOUT_MS = 300_000;
+const MAX_GH_OUTPUT_LENGTH = 4_000;
+const MAX_GH_ERROR_LENGTH = 400;
+// One local process coalesces concurrent prepares for the same archive.
+const cacheLocks = Effect.runSync(KeyedLock.make<string>());
+const sanitizeGhStderr = (value: string) => value
+  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
+  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
+  .replace(/(?:github_pat_|gh[opusr]_)[A-Za-z0-9_]+/gu, "[redacted]")
+  .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
+  .replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
+  .replace(/\s+/gu, " ").trim().slice(-MAX_GH_ERROR_LENGTH);
+const collectGhOutput = <E>(stream: Stream.Stream<Uint8Array, E>) =>
+  stream.pipe(
+    Stream.decodeText(),
+    Stream.runFold(
+      () => "",
+      (output, chunk) => (output + chunk).slice(-MAX_GH_OUTPUT_LENGTH),
+    ),
+  );
+
+/** Download locally; only verified archive bytes may reach SSH. */
+export const downloadRuntimeArchiveWithGh = Effect.fn("ssh.runtimeArchive.gh")(function* (
+  archiveDirectory: string,
+  version: string,
+  platformKey: CliArchivePlatformKey,
+  ghCommand = "gh",
+) {
+  const path = yield* Path.Path;
+  const directory = path.resolve(archiveDirectory);
+  const tag = `v${version}`;
+  const asset = cliArchiveFileName(version, platformKey);
+  const context = `repo=${CLI_RELEASE_REPOSITORY}, tag=${tag}, asset=${asset}, archive directory=${directory}`;
+  return yield* cacheLocks.withLock(path.join(directory, asset), Effect.gen(function* () {
+    const fs = yield* FileSystem.FileSystem;
+    // A racing prepare may have populated the cache while this one waited.
+    const cached = yield* readLocalRuntimeArchive(directory, version, platformKey);
+    if (cached !== null) return cached;
+    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
+    yield* fs.makeDirectory(directory, { recursive: true });
+    // Stage both files on the cache filesystem; publish complete files by rename.
+    const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".goat-gh-" });
+    yield* fs.chmod(staging, 0o700);
+    const child = yield* spawner.spawn(
+      ChildProcess.make(ghCommand, [
+        "release", "download", tag,
+        "--repo", CLI_RELEASE_REPOSITORY,
+        "--pattern", asset,
+        "--pattern", CLI_RELEASE_CHECKSUMS_FILE,
+        "--dir", staging,
+      ], {
+        env: { GH_PROMPT_DISABLED: "1" },
+        extendEnv: true, stdin: "ignore", shell: false,
+      }),
+    ).pipe(Effect.mapError((cause) =>
+      cause instanceof PlatformError.PlatformError && cause.reason._tag === "NotFound"
+        ? new SshLaunchError({
+            message: `gh not found on PATH (command=${ghCommand}; ${context}). Install gh or supply runner.ghCommand with an executable path.`,
+            stdout: "", cause,
+          })
+        : cause,
+    ));
+    const [, stderr, exitCode] = yield* Effect.all([
+      Stream.runDrain(child.stdout),
+      collectGhOutput(child.stderr),
+      child.exitCode.pipe(Effect.map(Number)),
+    ], { concurrency: "unbounded" });
+    if (exitCode !== 0) {
+      const diagnostic = sanitizeGhStderr(stderr);
+      return yield* new SshLaunchError({
+        message: `Local gh release download failed (exit ${exitCode}; ${context}). Check gh auth status and that the release contains both assets.${diagnostic === "" ? "" : ` stderr (last ${MAX_GH_ERROR_LENGTH} sanitized characters): ${diagnostic}`}`,
+        stdout: "",
+        cause: { exitCode, stderr: diagnostic },
+      });
+    }
+    const checksums = parseChecksums(
+      yield* fs.readFileString(path.join(staging, CLI_RELEASE_CHECKSUMS_FILE)),
+    );
+    const expected = checksums.get(asset);
+    if (expected === undefined) {
+      return yield* new SshLaunchError({
+        message: `SHA256SUMS has no valid checksum for the SSH runtime archive (${context}).`,
+        stdout: "",
+      });
+    }
+    const archive = yield* readLocalRuntimeArchive(staging, version, platformKey);
+    if (archive === null) {
+      return yield* new SshLaunchError({
+        message: `gh did not download the SSH runtime archive (${context}).`,
+        stdout: "",
+      });
+    }
+    if (archive.sha256 !== expected) {
+      return yield* new SshLaunchError({
+        message: `SSH runtime archive SHA-256 mismatch (${context}).`,
+        stdout: "",
+      });
+    }
+    const sidecar = `${asset}.sha256`;
+    yield* fs.writeFileString(path.join(staging, sidecar), `${expected}  ${asset}\n`);
+    // Sidecar first: interruption can leave a sidecar alone, never a gh
+    // archive that a later cache hit would mistake for a trusted local build.
+    yield* fs.rename(path.join(staging, sidecar), path.join(directory, sidecar));
+    yield* fs.rename(path.join(staging, asset), path.join(directory, asset));
+    return archive;
+  }).pipe(Effect.scoped)).pipe(
+    Effect.mapError((cause) =>
+      cause instanceof SshLaunchError && cause.message.includes(context)
+        ? cause
+        : new SshLaunchError({
+            message: `Failed to acquire the SSH runtime archive with local gh (${context}). Ensure gh is installed and authenticated, both release assets exist, and the archive directory is writable.`,
+            stdout: "",
+            cause,
+          }),
+    ),
+    Effect.timeoutOption(Duration.millis(GH_DOWNLOAD_TIMEOUT_MS)),
+    Effect.flatMap((result) => Option.match(result, {
+      onSome: Effect.succeed,
+      onNone: () => Effect.fail(new SshLaunchError({
+        message: `Local gh SSH runtime download timed out (${context}).`,
+        stdout: "",
+      })),
+    })),
+  );
+});
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/tunnel.ts` — MODIFY

```diff
--- a/packages/ssh/src/tunnel.ts
+++ b/packages/ssh/src/tunnel.ts
@@ -6,7 +6,12 @@
   describeReadinessCause,
   waitForHttpReady as waitForHttpReadyShared,
 } from "@t3tools/shared/httpReadiness";
-import { cliArchivePlatformKey, cliReleaseDownloadBaseUrl } from "@t3tools/shared/cliRelease";
+import {
+  CLI_RELEASE_REPOSITORY,
+  cliArchiveFileName,
+  cliArchivePlatformKey,
+  cliReleaseDownloadBaseUrl,
+} from "@t3tools/shared/cliRelease";
 import * as KeyedLock from "@t3tools/shared/KeyedLock";
 import * as NetService from "@t3tools/shared/Net";
 import { extractJsonObject, fromLenientJson } from "@t3tools/shared/schemaJson";
@@ -26,6 +31,7 @@

 import * as SshAuth from "./auth.ts";
 import { readLocalRuntimeArchive } from "./runtimeArchive.ts";
+import { downloadRuntimeArchiveWithGh } from "./runtimeArchiveGh.ts";
 import {
   baseSshArgs,
   buildSshHostSpecEffect,
@@ -81,6 +87,8 @@
   readonly archiveVersion?: string | null;
   readonly releaseBaseUrl?: string | null;
   readonly archiveDirectory?: string | null;
+  /** Local gh executable used for authenticated acquisition; defaults to PATH lookup. */
+  readonly ghCommand?: string | undefined;
   /**
    * Reuse the remote's existing `run-t3.sh` for this target instead of
    * replacing it. A second client of the same host (the server's own SSH
@@ -1095,8 +1103,12 @@
   runner?: RemoteT3RunnerOptions,
 ) =>
   Effect.gen(function* () {
-    if (isNodeScriptRunner(runner) || !runner?.archiveDirectory?.trim()) return;
-    const version = runner.archiveVersion?.trim() ?? "";
+    if (isNodeScriptRunner(runner)) return;
+    const directory = runner?.archiveDirectory?.trim() ?? "";
+    const mirror = runner?.releaseBaseUrl?.trim() ?? "";
+    // Explicit mirrors retain the existing path without a local cache.
+    if (directory === "" && mirror !== "") return;
+    const version = runner?.archiveVersion?.trim() ?? "";
     yield* Effect.annotateCurrentSpan({
       "ssh.target": target.alias,
       "t3.runtime.version": version,
@@ -1118,16 +1130,27 @@
       return;
     }
     const platformKey = cliArchivePlatformKey(probe.platform, probe.arch);
-    const archive =
-      platformKey === undefined
-        ? null
-        : yield* readLocalRuntimeArchive(runner.archiveDirectory.trim(), version, platformKey).pipe(
-            Effect.mapError(runtimePreparationError),
-          );
-    if (archive === null) {
+    if (platformKey === undefined || directory === "") {
+      if (mirror !== "") {
+        yield* Effect.annotateCurrentSpan("t3.runtime.source", "download");
+        return;
+      }
+      const asset = platformKey === undefined
+        ? `unsupported-${probe.platform}-${probe.arch}`
+        : cliArchiveFileName(version, platformKey);
+      return yield* new SshLaunchError({
+        message: `Cannot acquire the SSH runtime archive (repo=${CLI_RELEASE_REPOSITORY}, tag=v${version}, asset=${asset}, archive directory=${directory || "<not configured>"}). Configure a local archive directory and use a supported SSH platform, or an explicit release mirror.`,
+        stdout: "",
+      });
+    }
+    const localArchive = yield* readLocalRuntimeArchive(directory, version, platformKey).pipe(
+      Effect.mapError(runtimePreparationError),
+    );
+    if (localArchive === null && mirror !== "") {
       yield* Effect.annotateCurrentSpan("t3.runtime.source", "download");
       return;
     }
+    const archive = localArchive ?? (yield* downloadRuntimeArchiveWithGh(directory, version, platformKey, runner?.ghCommand));
     yield* Effect.annotateCurrentSpan({
       "t3.runtime.source": "upload",
       "t3.runtime.upload.bytes": archive.bytes.byteLength,
@@ -1135,7 +1158,7 @@
       "t3.runtime.upload.installComplete": false,
     });
     const script = yield* Effect.try({
-      try: () => buildRemoteUploadScript(runner, archive.sha256),
+      try: () => buildRemoteUploadScript({ ...runner, archiveVersion: version }, archive.sha256),
       catch: runtimePreparationError,
     });
     yield* runSshCommand(target, {
@@ -1287,10 +1310,11 @@
     runner?: RemoteT3RunnerOptions,
   ): Effect.fn.Return<
     RemoteMcpClientSession,
-    SshCommandError | SshInvalidTargetError | SshPairingError,
+    SshCommandError | SshInvalidTargetError | SshPairingError | SshLaunchError,
     ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
   > {
     const stateKey = yield* remoteStateKey(target);
+    yield* prepareRemoteRuntime(target, input ?? {}, runner);
     const result = yield* runSshCommand(target, {
       remoteCommandArgs: ["sh", "-s"],
       stdin: buildRemoteMcpSessionScript(stateKey, sessionOptions, runner),
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/sshRemote/SshRemoteDispatch.ts` — MODIFY (A3 mirror forwarding)

```diff
--- a/apps/server/src/sshRemote/SshRemoteDispatch.ts
+++ b/apps/server/src/sshRemote/SshRemoteDispatch.ts
@@ -598,22 +598,33 @@
   return SshRemoteDispatch.of({ listHosts, browse, launchThread });
 });

+/** Resolve local archive/mirror configuration before building the remote runner. */
+export const resolveSshCliRunner = (baseDir: string) => Effect.gen(function* () {
+  const archiveDirectory = yield* Config.String("T3CODE_SSH_RUNTIME_ARCHIVE_DIR").pipe(
+    Config.withDefault(baseDir + "/runtime/archives"),
+  );
+  const releaseBaseUrl = yield* Config.String("T3CODE_RELEASE_BASE_URL").pipe(
+    Config.withDefault(""),
+    Effect.map((value) => value.trim() || undefined),
+  );
+  return {
+    archiveVersion: packageJson.version,
+    archiveDirectory,
+    ...(releaseBaseUrl === undefined ? {} : { releaseBaseUrl }),
+    keepExistingRunner: true,
+  } satisfies SshTunnel.RemoteT3RunnerOptions;
+});
+
 const layerManager = Layer.unwrap(
   Effect.gen(function* () {
     const config = yield* ServerConfig.ServerConfig;
-    const archiveDirectory = yield* Config.String("T3CODE_SSH_RUNTIME_ARCHIVE_DIR").pipe(
-      Config.withDefault(config.baseDir + "/runtime/archives"),
-    );
+    const runner = yield* resolveSshCliRunner(config.baseDir);
     return SshTunnel.SshEnvironmentManager.layer({
       // Reuse whatever runner a desktop already left for the host, so this
       // never restarts a remote server another client is using. A host with
       // none gets this server's own release, uploaded from a local archive
       // when the build is unpublished, as the desktop does.
-      resolveCliRunner: Effect.succeed({
-        archiveVersion: packageJson.version,
-        archiveDirectory,
-        keepExistingRunner: true,
-      }),
+      resolveCliRunner: Effect.succeed(runner),
       leaveRemoteServerRunning: true,
     });
   }),
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/sshRemote/SshRemoteDispatch.test.ts` — MODIFY (A3 mirror forwarding)

```diff
--- a/apps/server/src/sshRemote/SshRemoteDispatch.test.ts
+++ b/apps/server/src/sshRemote/SshRemoteDispatch.test.ts
@@ -1,6 +1,10 @@
 import { describe, expect, it } from "@effect/vitest";

-import { matchRemoteProject, readRemoteToolResult } from "./SshRemoteDispatch.ts";
+import * as ConfigProvider from "effect/ConfigProvider";
+import * as Effect from "effect/Effect";
+import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";
+
+import { matchRemoteProject, readRemoteToolResult, resolveSshCliRunner } from "./SshRemoteDispatch.ts";

 describe("matchRemoteProject", () => {
   const project = { id: "project-1", workspaceRoot: "/home/agent/repo/" };
@@ -148,3 +152,36 @@
     });
   });
 });
+
+
+describe("SSH dispatch release mirror", () => {
+  it.effect("server runner downloads from the configured mirror", () =>
+    Effect.gen(function* () {
+      const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
+        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({
+          T3CODE_RELEASE_BASE_URL: "  https://mirror.example/goat/  ",
+        })),
+      );
+      const script = buildRemoteT3RunnerScript(runner);
+      expect(script).toContain("T3_RELEASE_BASE_URL='https://mirror.example/goat'");
+      expect(script).not.toContain("github.com/goat-si/goat/releases/download");
+      expect(runner.archiveDirectory).toBe("/fixture/home/runtime/archives");
+      expect(runner.keepExistingRunner).toBe(true);
+    }),
+  );
+
+  it.effect.each([undefined, "", "  "])("empty mirror %s keeps the authenticated default", (value) =>
+    Effect.gen(function* () {
+      const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
+        Effect.provideService(ConfigProvider.ConfigProvider,
+          ConfigProvider.fromEnvRecord({ T3CODE_RELEASE_BASE_URL: value },
+            { preserveEmptyStrings: true })),
+      );
+      expect("releaseBaseUrl" in runner).toBe(false);
+      expect(buildRemoteT3RunnerScript(runner))
+        .toContain("T3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'");
+      // The library's blank-mirror behavior test separately proves gh acquisition,
+      // since running the generated shell directly is outside the guarded path.
+    }),
+  );
+});
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/tunnel.test.ts` — MODIFY

```diff
--- a/packages/ssh/src/tunnel.test.ts
+++ b/packages/ssh/src/tunnel.test.ts
@@ -97,6 +97,8 @@
 }

 const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
+// Protocol-only cases explicitly select the mirror compatibility path.
+const PROTOCOL_ARCHIVE = { ...ARCHIVE, releaseBaseUrl: "https://example.invalid/mirror" };
 const NODE_SCRIPT = {
   nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
 } as const;
@@ -225,7 +227,7 @@
     assert.include(script, "T3_NODE_SCRIPT_PATH=''");
     assert.include(
       script,
-      "T3_RELEASE_BASE_URL='https://github.com/pingdotgg/t3code/releases/download'",
+      "T3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'",
     );
     assert.include(script, 'T3_RUNTIME_DIR="$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION"');
     assert.include(script, 'T3_ARCHIVE="t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"');
@@ -444,7 +446,7 @@
     const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

     return Effect.gen(function* () {
-      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
+      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, PROTOCOL_ARCHIVE);
       assert.equal(result.remotePort, 3774);
       assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
     }).pipe(Effect.provide(layerProcess));
@@ -490,7 +492,7 @@

     return Effect.gen(function* () {
       const fiber = yield* Effect.forkChild(
-        SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE),
+        SshTunnel.launchOrReuseRemoteServer(target, undefined, PROTOCOL_ARCHIVE),
       );
       yield* Effect.yieldNow;
       yield* TestClock.adjust(Duration.seconds(800));
@@ -571,7 +573,7 @@
     const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
     const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
     return Effect.gen(function* () {
-      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
+      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, PROTOCOL_ARCHIVE);
       assert.equal(result.credential, "LCL4R2TPHDKQ");
     }).pipe(Effect.provide(layerProcess));
   });
@@ -599,7 +601,7 @@
     const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
     const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
     return Effect.gen(function* () {
-      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
+      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, PROTOCOL_ARCHIVE);
       assert.equal(result.credential, "LCL4R2TPHDKQ");
     }).pipe(Effect.provide(layerProcess));
   });
@@ -644,7 +646,7 @@
         Layer.succeed(HttpClient.HttpClient, testHttpClient),
         Layer.succeed(NetService.NetService, testNetService),
         SshAuth.SshPasswordPrompt.disabledLayer,
-        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
+        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE) }),
       );
       const target = {
         alias: "devbox",
@@ -769,7 +771,7 @@
           Layer.succeed(HttpClient.HttpClient, testHttpClient),
           Layer.succeed(NetService.NetService, testNetService),
           SshAuth.SshPasswordPrompt.disabledLayer,
-          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
+          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(PROTOCOL_ARCHIVE) }),
         );
         yield* Effect.gen(function* () {
           const manager = yield* SshTunnel.SshEnvironmentManager;
@@ -907,7 +909,7 @@

   it.live.each([
     "uploads the local archive to a cold remote",
-    "downloads when no local archive exists",
+    "downloads from an explicit mirror when no local archive exists",
     "skips upload when the remote runtime is ready",
     "passes the same auth options to probe, upload and launch",
   ] as const)("%s", (name) =>
@@ -915,7 +917,7 @@
       const fixture = yield* makeUploadFixture();
       const { root, directory, bytes, fs, spawner: realSpawner } = fixture;
       const ready = name === "skips upload when the remote runtime is ready";
-      const missing = name === "downloads when no local archive exists";
+      const missing = name === "downloads from an explicit mirror when no local archive exists";
       const archiveDirectory = missing || ready ? `${root}/missing` : directory;
       const runner = {
         ...ARCHIVE,
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/install.sh` — MODIFY

```diff
--- a/scripts/install.sh
+++ b/scripts/install.sh
@@ -17,7 +17,7 @@
 # instead of fetching the release again.
 set -eu

-repo="pingdotgg/t3code"
+repo="goat-si/goat"
 base_url="${T3CODE_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
 t3_home="${T3CODE_HOME:-$HOME/.t3}"
 bin_dir="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/install.ps1` — MODIFY

```diff
--- a/scripts/install.ps1
+++ b/scripts/install.ps1
@@ -16,7 +16,7 @@
 $ErrorActionPreference = "Stop"
 [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

-$repo = "pingdotgg/t3code"
+$repo = "goat-si/goat"
 $baseUrl = if ($env:T3CODE_RELEASE_BASE_URL) { $env:T3CODE_RELEASE_BASE_URL.TrimEnd("/") } else { "https://github.com/$repo/releases/download" }
 $t3Home = if ($env:T3CODE_HOME) { $env:T3CODE_HOME } else { Join-Path $HOME ".t3" }
 $binDir = if ($env:T3CODE_INSTALL_BIN_DIR) { $env:T3CODE_INSTALL_BIN_DIR } else { Join-Path $HOME ".local\bin" }
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packaging/aur/scripts/release.sh` — MODIFY

```diff
--- a/packaging/aur/scripts/release.sh
+++ b/packaging/aur/scripts/release.sh
@@ -2,7 +2,7 @@
 set -euo pipefail

 repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
-repo='pingdotgg/t3code'
+repo='goat-si/goat'
 tag="${RELEASE_TAG:?RELEASE_TAG is required}"
 pkgrel="${PKGREL:-1}"

```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/marketing/src/lib/releases.ts` — MODIFY

```diff
--- a/apps/marketing/src/lib/releases.ts
+++ b/apps/marketing/src/lib/releases.ts
@@ -1,4 +1,4 @@
-const REPO = "pingdotgg/t3code";
+const REPO = "goat-si/goat";

 export const RELEASES_URL = `https://github.com/${REPO}/releases`;
 export const NIGHTLY_RELEASES_URL = `${RELEASES_URL}?q=nightly&expanded=true`;
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packaging/aur/t3code-bin/PKGBUILD` — MODIFY

```diff
--- a/packaging/aur/t3code-bin/PKGBUILD
+++ b/packaging/aur/t3code-bin/PKGBUILD
@@ -5,7 +5,7 @@
 pkgrel=1
 pkgdesc='Desktop control surface for local coding agents'
 arch=('x86_64')
-url='https://github.com/pingdotgg/t3code'
+url='https://github.com/goat-si/goat'
 license=('MIT')
 depends=(
   'alsa-lib'
@@ -45,8 +45,8 @@

 _appimage="T3-Code-${pkgver}-x86_64.AppImage"
 source=(
-  "$_appimage::https://github.com/pingdotgg/t3code/releases/download/v${pkgver}/$_appimage"
-  "${pkgname}-${pkgver}-LICENSE::https://raw.githubusercontent.com/pingdotgg/t3code/v${pkgver}/LICENSE"
+  "$_appimage::https://github.com/goat-si/goat/releases/download/v${pkgver}/$_appimage"
+  "${pkgname}-${pkgver}-LICENSE::https://raw.githubusercontent.com/goat-si/goat/v${pkgver}/LICENSE"
 )
 sha256sums=(
   '415c8648f43c3d22d572f27f2c50fdc8c310ea7fcde9537b903e1e2f1c8775a1' # AppImage
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packaging/aur/t3code-nightly-bin/PKGBUILD` — MODIFY

```diff
--- a/packaging/aur/t3code-nightly-bin/PKGBUILD
+++ b/packaging/aur/t3code-nightly-bin/PKGBUILD
@@ -5,7 +5,7 @@
 pkgrel=1
 pkgdesc='Nightly desktop control surface for local coding agents'
 arch=('x86_64')
-url='https://github.com/pingdotgg/t3code'
+url='https://github.com/goat-si/goat'
 license=('MIT')
 depends=(
   'alsa-lib'
@@ -46,8 +46,8 @@
 _upstream_version="${pkgver/_nightly./-nightly.}"
 _appimage="T3-Code-${_upstream_version}-x86_64.AppImage"
 source=(
-  "$_appimage::https://github.com/pingdotgg/t3code/releases/download/v${_upstream_version}/$_appimage"
-  "${pkgname}-${pkgver}-LICENSE::https://raw.githubusercontent.com/pingdotgg/t3code/v${_upstream_version}/LICENSE"
+  "$_appimage::https://github.com/goat-si/goat/releases/download/v${_upstream_version}/$_appimage"
+  "${pkgname}-${pkgver}-LICENSE::https://raw.githubusercontent.com/goat-si/goat/v${_upstream_version}/LICENSE"
 )
 sha256sums=(
   'c4dea5bba9ed0b51b2f60f2d4a4867e61d62b57c50ea66f2792a73112e054566' # AppImage
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-npm-platform-packages.ts` — MODIFY

````diff
--- a/scripts/build-npm-platform-packages.ts
+++ b/scripts/build-npm-platform-packages.ts
@@ -163,7 +163,7 @@
     `npx ${NPM_LAUNCHER_PACKAGE_NAME}@latest`,
     "```",
     "",
-    "Source and documentation: https://github.com/pingdotgg/t3code",
+    "Source and documentation: https://github.com/goat-si/goat",
     "",
   ].join("\n");
 }
@@ -210,7 +210,7 @@
       "t3: no T3 Code CLI build is available for this platform (" + key + ").",
       "Supported platforms: " + SUPPORTED.join(", ") + ".",
       "If yours is listed, reinstall t3 so npm fetches its optional dependency.",
-      "The desktop app and release archives are at https://github.com/pingdotgg/t3code/releases",
+      "The desktop app and release archives are at https://github.com/goat-si/goat/releases",
       "",
     ].join("\\n"),
   );
````

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-npm-platform-packages.test.ts` — MODIFY

```diff
--- a/scripts/build-npm-platform-packages.test.ts
+++ b/scripts/build-npm-platform-packages.test.ts
@@ -255,7 +255,7 @@
       assert.equal(unsupported.exitCode, 1);
       assert.include(unsupported.stderr, "linux-x64");
       assert.include(unsupported.stderr, "win32-arm64");
-      assert.include(unsupported.stderr, "https://github.com/pingdotgg/t3code/releases");
+      assert.include(unsupported.stderr, "https://github.com/goat-si/goat/releases");
     }),
   );
 });
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/desktopUpdate.logic.ts` — MODIFY

```diff
--- a/apps/web/src/components/desktopUpdate.logic.ts
+++ b/apps/web/src/components/desktopUpdate.logic.ts
@@ -1,8 +1,9 @@
 import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
+import { CLI_RELEASE_REPOSITORY } from "@t3tools/shared/cliRelease";

 export type DesktopUpdateButtonAction = "download" | "install" | "none";

-const DESKTOP_RELEASE_HISTORY_URL = "https://github.com/pingdotgg/t3code/releases";
+const DESKTOP_RELEASE_HISTORY_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases`;
 const DESKTOP_RELEASE_TAG_URL = `${DESKTOP_RELEASE_HISTORY_URL}/tag`;

 /**
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/desktopUpdate.logic.test.ts` — MODIFY

```diff
--- a/apps/web/src/components/desktopUpdate.logic.test.ts
+++ b/apps/web/src/components/desktopUpdate.logic.test.ts
@@ -182,13 +182,13 @@
 describe("desktop update UI helpers", () => {
   it("builds the stable release URL for a downloaded version", () => {
     expect(getDesktopUpdateReleaseUrl("0.0.30")).toBe(
-      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30",
+      "https://github.com/goat-si/goat/releases/tag/v0.0.30",
     );
   });

   it("builds the nightly release URL without dropping its version suffix", () => {
     expect(getDesktopUpdateReleaseUrl("0.0.30-nightly.20260728.931")).toBe(
-      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30-nightly.20260728.931",
+      "https://github.com/goat-si/goat/releases/tag/v0.0.30-nightly.20260728.931",
     );
   });

@@ -199,7 +199,7 @@

   it("builds the release history URL", () => {
     expect(getDesktopUpdateReleaseHistoryUrl()).toBe(
-      "https://github.com/pingdotgg/t3code/releases",
+      "https://github.com/goat-si/goat/releases",
     );
   });

```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/desktopUpdate.toast.test.tsx` — MODIFY

```diff
--- a/apps/web/src/components/desktopUpdate.toast.test.tsx
+++ b/apps/web/src/components/desktopUpdate.toast.test.tsx
@@ -73,7 +73,7 @@
     link?.props.onClick?.();
     await vi.waitFor(() => {
       expect(openExternal).toHaveBeenCalledWith(
-        "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30",
+        "https://github.com/goat-si/goat/releases/tag/v0.0.30",
       );
     });
     expect(testState.addToast).toHaveBeenCalledTimes(1);
@@ -91,7 +91,7 @@

     await vi.waitFor(() => {
       expect(openExternal).toHaveBeenCalledWith(
-        "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30",
+        "https://github.com/goat-si/goat/releases/tag/v0.0.30",
       );
     });
   });
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx` — MODIFY

```diff
--- a/apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx
+++ b/apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx
@@ -87,9 +87,9 @@
     );

     expect(anchors.map(({ props }) => props.href)).toEqual([
-      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.3",
-      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.2",
-      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.1",
+      "https://github.com/goat-si/goat/releases/tag/v0.0.36-nightly.3",
+      "https://github.com/goat-si/goat/releases/tag/v0.0.36-nightly.2",
+      "https://github.com/goat-si/goat/releases/tag/v0.0.36-nightly.1",
     ]);
     expect(anchors.map(({ props }) => textContent(props.children))).toEqual([
       "View release on GitHub",
@@ -107,7 +107,7 @@
       }),
     );

-    expect(anchors.at(-1)?.props.href).toBe("https://github.com/pingdotgg/t3code/releases");
+    expect(anchors.at(-1)?.props.href).toBe("https://github.com/goat-si/goat/releases");
     expect(textContent(anchors.at(-1)?.props.children)).toBe("1 older release on GitHub");
   });

@@ -141,7 +141,7 @@
     expect(preventDefault).toHaveBeenCalledOnce();
     await vi.waitFor(() => {
       expect(openExternal).toHaveBeenCalledWith(
-        "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.3",
+        "https://github.com/goat-si/goat/releases/tag/v0.0.36-nightly.3",
       );
       expect(testState.addToast).toHaveBeenCalledWith({
         type: "error",
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/runtimeArchiveGh.test.ts` — NEW

Before: absent. After: complete behavior tests. The fake intercepts `gh` and SSH through the existing spawner service, writes actual files into the supplied --dir, and lets production parsing/hash/publication/upload selection run unchanged. It does not mock the acquisition logic.

```diff
--- /dev/null
+++ b/packages/ssh/src/runtimeArchiveGh.test.ts
@@ -0,0 +1,437 @@
+import * as NodeServices from "@effect/platform-node/NodeServices";
+import { assert, describe, it } from "@effect/vitest";
+import { CLI_RELEASE_REPOSITORY, cliArchiveFileName } from "@t3tools/shared/cliRelease";
+import * as Deferred from "effect/Deferred";
+import * as Duration from "effect/Duration";
+import * as Effect from "effect/Effect";
+import * as Fiber from "effect/Fiber";
+import * as FileSystem from "effect/FileSystem";
+import * as Result from "effect/Result";
+import * as Scope from "effect/Scope";
+import * as Sink from "effect/Sink";
+import * as Stream from "effect/Stream";
+import { TestClock } from "effect/testing";
+import { ChildProcess, ChildProcessSpawner } from "effect/process";
+
+import { SshLaunchError } from "./errors.ts";
+import { downloadRuntimeArchiveWithGh } from "./runtimeArchiveGh.ts";
+import * as SshTunnel from "./tunnel.ts";
+
+const version = "1.2.3-preview.20260911.4";
+const asset = cliArchiveFileName(version, "linux-x64");
+const bytes = new Uint8Array([0, 128, 255]);
+const sha256 = "5240672d7b51756b829ad0ef8d9468b7a078afa2f410484fd3892dab47becb72";
+const target = { alias: "devbox", hostname: "devbox", username: null, port: null } as const;
+const encoder = new TextEncoder();
+
+function processHandle(stdout = "", code = 0, stderr = "") {
+  const output = Stream.make(encoder.encode(stdout));
+  return ChildProcessSpawner.makeHandle({
+    pid: ChildProcessSpawner.ProcessId(123),
+    stdout: output,
+    stderr: Stream.make(encoder.encode(stderr)),
+    all: output,
+    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
+    isRunning: Effect.succeed(false),
+    kill: () => Effect.void,
+    stdin: Sink.drain,
+    getInputFd: () => Sink.drain,
+    getOutputFd: () => Stream.empty,
+    unref: Effect.succeed(Effect.void),
+  });
+}
+
+type Mode = "ok" | "missing-release" | "stderr" | "mismatch" | "missing-checksum" | "missing-asset";
+const diagnosticSecret = `ghp_${"x".repeat(36)}`;
+const diagnosticStderr = "noise ".repeat(1000) +
+  `\x1b[31mauthentication failed\x1b[0m Bearer ${diagnosticSecret}\r\n\x00`;
+interface DownloadBarrier {
+  readonly entered: Deferred.Deferred<void>;
+  readonly release: Deferred.Deferred<void>;
+  readonly secondProbe: Deferred.Deferred<void>;
+}
+const fixture = Effect.fn("test.ghFixture")(function* (
+  mode: Mode = "ok", ready = false, unsupported = false,
+  barrier?: DownloadBarrier, ghCommand = "gh",
+) {
+  const fs = yield* FileSystem.FileSystem;
+  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-gh-test-" });
+  const directory = `${root}/archive cache`;
+  yield* fs.makeDirectory(directory);
+  const calls: string[] = [];
+  const commands: ChildProcess.StandardCommand[] = [];
+  const uploads: Uint8Array[] = [];
+  const staging: string[] = [];
+  const spawner = ChildProcessSpawner.make((command) => Effect.gen(function* () {
+    assert.equal(command._tag, "StandardCommand");
+    if (command._tag !== "StandardCommand") return processHandle();
+    commands.push(command);
+    if (command.command === ghCommand) {
+      calls.push("gh");
+      const temp = command.args[command.args.indexOf("--dir") + 1];
+      assert.isDefined(temp);
+      if (temp === undefined) return processHandle("", 1);
+      staging.push(temp);
+      if (mode === "missing-release") return processHandle("", 1, "release not found");
+      if (mode === "stderr") return processHandle("", 1, diagnosticStderr);
+      if (barrier !== undefined) {
+        yield* fs.writeFile(`${temp}/${asset}`, bytes.slice(0, 1));
+        yield* Deferred.succeed(barrier.entered, undefined);
+        yield* Deferred.await(barrier.release);
+      }
+      if (mode !== "missing-asset") yield* fs.writeFile(`${temp}/${asset}`, bytes);
+      const digest = mode === "mismatch" ? "0".repeat(64) : sha256.toUpperCase();
+      yield* fs.writeFileString(`${temp}/SHA256SUMS`, mode === "missing-checksum"
+        ? "not a checksum\n" : `${digest} *${asset}\n`);
+      return processHandle();
+    }
+    assert.isTrue(command.command === "ssh" || command.command === "ssh.exe");
+    const input = command.options.stdin;
+    const chunks = input !== undefined && typeof input === "object" &&
+      "stream" in input && Stream.isStream(input.stream)
+      ? yield* input.stream.pipe(Stream.runCollect) : [];
+    const data = new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk)));
+    if (command.args.includes("-c")) {
+      calls.push("upload");
+      uploads.push(data);
+      return processHandle();
+    }
+    const script = new TextDecoder().decode(data);
+    if (script.includes("ready=false")) {
+      calls.push("probe");
+      if (barrier !== undefined && calls.filter((call) => call === "probe").length === 2) {
+        yield* Deferred.succeed(barrier.secondProbe, undefined);
+      }
+      return processHandle(JSON.stringify({
+        platform: unsupported ? "darwin" : "linux", arch: "x64", ready,
+      }));
+    }
+    if (script.includes("set -- auth session issue")) {
+      calls.push("mcp");
+      return processHandle('T3_CEILING=default\n{"token":"fixture-session","expiresAt":null}');
+    }
+    if (command.args.includes("--")) {
+      calls.push("launch");
+      return processHandle('{"remotePort":3773,"serverKind":"managed"}');
+    }
+    calls.push("pairing");
+    return processHandle('{"credential":"fixture-pairing"}');
+  }));
+  return { fs, root, directory, calls, commands, uploads, staging, spawner };
+});
+
+function assertContext(error: unknown, directory: string, expectedAsset = asset) {
+  assert.instanceOf(error, SshLaunchError);
+  if (!(error instanceof SshLaunchError)) return;
+  for (const value of [CLI_RELEASE_REPOSITORY, `v${version}`, expectedAsset, directory]) {
+    assert.include(error.message, value);
+  }
+}
+
+const assertCleanStaging = Effect.fn("test.cleanStaging")(function* (
+  state: Effect.Success<ReturnType<typeof fixture>>,
+) {
+  for (const directory of state.staging) assert.isFalse(yield* state.fs.exists(directory));
+});
+
+function invoke(entry: "launch" | "pairing" | "mcp", runner: SshTunnel.RemoteT3RunnerOptions) {
+  return entry === "launch"
+    ? SshTunnel.launchOrReuseRemoteServer(target, {}, runner).pipe(Effect.asVoid)
+    : entry === "pairing"
+      ? SshTunnel.issueRemotePairingToken(target, {}, runner).pipe(Effect.asVoid)
+      : SshTunnel.issueRemoteMcpClientSession(target, {
+          ttl: "1h", label: "fixture", runtimeModeCeiling: null,
+        }, {}, runner).pipe(Effect.asVoid);
+}
+
+describe("SSH archives from locally authenticated gh", () => {
+  it.effect.each(["launch", "pairing", "mcp"] as const)(
+    "verified gh archive is uploaded before %s",
+    (entry) => Effect.gen(function* () {
+      const state = yield* fixture();
+      yield* invoke(entry, { archiveVersion: version, archiveDirectory: state.directory }).pipe(
+        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner),
+      );
+      assert.deepEqual(state.calls, ["probe", "gh", "upload", entry]);
+      assert.deepEqual(state.uploads, [bytes]);
+      assert.deepEqual(yield* state.fs.readFile(`${state.directory}/${asset}`), bytes);
+      assert.equal(yield* state.fs.readFileString(`${state.directory}/${asset}.sha256`),
+        `${sha256}  ${asset}\n`);
+      const command = state.commands.find((item) => item.command === "gh");
+      assert.deepEqual(command?.args, [
+        "release", "download", `v${version}`, "--repo", CLI_RELEASE_REPOSITORY,
+        "--pattern", asset, "--pattern", "SHA256SUMS", "--dir", state.staging[0],
+      ]);
+      assert.equal(command?.options.shell, false);
+      assert.equal(command?.options.env?.GH_PROMPT_DISABLED, "1");
+      assert.equal(command?.options.env?.T3_SSH_AUTH_SECRET, undefined);
+      yield* assertCleanStaging(state);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+  it.effect.each(["launch", "pairing", "mcp"] as const)(
+    "missing release fails %s clearly with no remote acquisition",
+    (entry) => Effect.gen(function* () {
+      const state = yield* fixture("missing-release");
+      const result = yield* Effect.result(invoke(entry, {
+        archiveVersion: version, archiveDirectory: state.directory,
+      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)));
+      assert.isTrue(Result.isFailure(result));
+      if (Result.isFailure(result)) assertContext(result.failure, state.directory);
+      assert.deepEqual(state.calls, ["probe", "gh"]);
+      assert.isFalse(yield* state.fs.exists(`${state.directory}/${asset}`));
+      yield* assertCleanStaging(state);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+  it.effect.each(["mismatch", "missing-checksum", "missing-asset"] as const)(
+    "%s never publishes or uploads an unverified archive",
+    (mode) => Effect.gen(function* () {
+      const state = yield* fixture(mode);
+      const result = yield* Effect.result(invoke("launch", {
+        archiveVersion: version, archiveDirectory: state.directory,
+      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)));
+      assert.isTrue(Result.isFailure(result));
+      if (Result.isFailure(result)) {
+        assertContext(result.failure, state.directory);
+        if (mode === "mismatch") assert.include(result.failure.message, "SHA-256 mismatch");
+      }
+      assert.deepEqual(state.calls, ["probe", "gh"]);
+      assert.deepEqual(state.uploads, []);
+      assert.deepEqual(yield* state.fs.readDirectory(state.directory), []);
+      yield* assertCleanStaging(state);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+  it.effect("explicit mirror retains remote download and never invokes gh", () =>
+    Effect.gen(function* () {
+      const state = yield* fixture("missing-release");
+      yield* invoke("launch", {
+        archiveVersion: version, archiveDirectory: state.directory,
+        releaseBaseUrl: "https://mirror.example/goat/",
+      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner));
+      assert.deepEqual(state.calls, ["probe", "launch"]);
+      assert.deepEqual(state.uploads, []);
+      assert.deepEqual(yield* state.fs.readDirectory(state.directory), []);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+  it.effect.each(["ready", "cached"] as const)("%s skips gh", (mode) =>
+    Effect.gen(function* () {
+      const state = yield* fixture("missing-release", mode === "ready");
+      if (mode === "cached") yield* state.fs.writeFile(`${state.directory}/${asset}`, bytes);
+      yield* invoke("launch", { archiveVersion: version, archiveDirectory: state.directory }).pipe(
+        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner),
+      );
+      assert.deepEqual(state.calls, mode === "ready"
+        ? ["probe", "launch"] : ["probe", "upload", "launch"]);
+      assert.deepEqual(state.uploads, mode === "ready" ? [] : [bytes]);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+  it.effect("blank mirror does not authorize anonymous download", () =>
+    Effect.gen(function* () {
+      const state = yield* fixture("missing-release");
+      const result = yield* Effect.result(invoke("launch", {
+        archiveVersion: version, archiveDirectory: state.directory, releaseBaseUrl: "  ",
+      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)));
+      assert.isTrue(Result.isFailure(result));
+      assert.deepEqual(state.calls, ["probe", "gh"]);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+  it.effect.each(["directory", "platform"] as const)(
+    "missing supported %s fails before launch",
+    (mode) => Effect.gen(function* () {
+      const state = yield* fixture("ok", false, mode === "platform");
+      const result = yield* Effect.result(invoke("launch", {
+        archiveVersion: version,
+        ...(mode === "platform" ? { archiveDirectory: state.directory } : {}),
+      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)));
+      assert.isTrue(Result.isFailure(result));
+      if (Result.isFailure(result)) assertContext(result.failure,
+        mode === "platform" ? state.directory : "<not configured>",
+        mode === "platform" ? "unsupported-darwin-x64" : asset);
+      assert.deepEqual(state.calls, ["probe"]);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+
+  it.effect("minimal PATH reports gh not found on PATH with no remote acquisition", () =>
+    Effect.gen(function* () {
+      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
+      const state = yield* fixture();
+      const emptyPath = `${state.root}/empty-path`;
+      yield* state.fs.makeDirectory(emptyPath);
+      const spawner = ChildProcessSpawner.make((command) => {
+        if (command._tag !== "StandardCommand" || command.command !== "gh") {
+          return state.spawner.spawn(command);
+        }
+        // Real Node spawn, isolated child environment; never mutate process.env.
+        return realSpawner.spawn(ChildProcess.make(command.command, command.args, {
+          ...command.options, extendEnv: false,
+          env: { PATH: emptyPath, GH_PROMPT_DISABLED: "1" },
+        }));
+      });
+      const result = yield* Effect.result(invoke("launch", {
+        archiveVersion: version, archiveDirectory: state.directory,
+      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)));
+      assert.isTrue(Result.isFailure(result));
+      if (Result.isFailure(result)) {
+        assertContext(result.failure, state.directory);
+        assert.include(result.failure.message, "gh not found on PATH");
+      }
+      assert.deepEqual(state.calls, ["probe"]);
+      assert.deepEqual(state.uploads, []);
+      assert.deepEqual(yield* state.fs.readDirectory(state.directory), []);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+  it.effect("ghCommand override acquires and uploads from a spaced executable path", () =>
+    Effect.gen(function* () {
+      const ghCommand = "/fixture tools/gh";
+      const state = yield* fixture("ok", false, false, undefined, ghCommand);
+      yield* invoke("launch", {
+        archiveVersion: version, archiveDirectory: state.directory, ghCommand,
+      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner));
+      assert.deepEqual(state.calls, ["probe", "gh", "upload", "launch"]);
+      assert.deepEqual(state.uploads, [bytes]);
+      assert.deepEqual(yield* state.fs.readFile(`${state.directory}/${asset}`), bytes);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+  it.effect("gh failure includes bounded sanitized stderr", () =>
+    Effect.gen(function* () {
+      const state = yield* fixture("stderr");
+      const result = yield* Effect.result(invoke("launch", {
+        archiveVersion: version, archiveDirectory: state.directory,
+      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)));
+      assert.isTrue(Result.isFailure(result));
+      if (Result.isFailure(result)) {
+        assertContext(result.failure, state.directory);
+        assert.include(result.failure.message, "authentication failed");
+        assert.include(result.failure.message, "[redacted]");
+        assert.notInclude(result.failure.message, diagnosticSecret);
+        assert.notMatch(result.failure.message, /[\x00-\x1f\x7f-\x9f]/u);
+        assert.isAtMost(result.failure.message.length, 1000);
+      }
+      assert.deepEqual(state.calls, ["probe", "gh"]);
+      assert.deepEqual(state.uploads, []);
+      yield* assertCleanStaging(state);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+  it.effect.each(["valid", "tampered", "malformed"] as const)(
+    "cached archive with %s sidecar is checked before upload",
+    (mode) => Effect.gen(function* () {
+      const state = yield* fixture("missing-release");
+      yield* state.fs.writeFile(`${state.directory}/${asset}`,
+        mode === "tampered" ? new Uint8Array([1, 128, 255]) : bytes);
+      yield* state.fs.writeFileString(`${state.directory}/${asset}.sha256`,
+        mode === "malformed" ? "not a checksum\n" : `${sha256}  ${asset}\n`);
+      const result = yield* Effect.result(invoke("launch", {
+        archiveVersion: version, archiveDirectory: state.directory,
+      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner)));
+      if (mode === "valid") {
+        assert.isTrue(Result.isSuccess(result));
+        assert.deepEqual(state.calls, ["probe", "upload", "launch"]);
+        assert.deepEqual(state.uploads, [bytes]);
+      } else {
+        assert.isTrue(Result.isFailure(result));
+        if (Result.isFailure(result)) {
+          assert.instanceOf(result.failure, SshLaunchError);
+          assert.include(result.failure.message, "SHA-256 mismatch or malformed sidecar");
+        }
+        assert.deepEqual(state.calls, ["probe"]);
+        assert.deepEqual(state.uploads, []);
+      }
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+  it.effect("two prepares race with one complete cache publication and no partial visible", () =>
+    Effect.gen(function* () {
+      const barrier: DownloadBarrier = {
+        entered: yield* Deferred.make<void>(),
+        release: yield* Deferred.make<void>(),
+        secondProbe: yield* Deferred.make<void>(),
+      };
+      const state = yield* fixture("ok", false, false, barrier);
+      const archivePath = `${state.directory}/${asset}`;
+      const sidecarPath = `${archivePath}.sha256`;
+      const observed: string[] = [];
+      const observedFs = {
+        ...state.fs,
+        rename: (from: string, to: string) => Effect.gen(function* () {
+          if (to === archivePath) {
+            // Observe the actual filesystem on both sides of the publication.
+            assert.isFalse(yield* state.fs.exists(archivePath));
+            assert.deepEqual(yield* state.fs.readFile(from), bytes);
+            assert.equal(yield* state.fs.readFileString(sidecarPath), `${sha256}  ${asset}\n`);
+          }
+          yield* state.fs.rename(from, to);
+          if (to === archivePath) {
+            assert.deepEqual(yield* state.fs.readFile(archivePath), bytes);
+            observed.push("archive");
+          } else if (to === sidecarPath) {
+            assert.isFalse(yield* state.fs.exists(archivePath));
+            assert.equal(yield* state.fs.readFileString(sidecarPath), `${sha256}  ${asset}\n`);
+            observed.push("sidecar");
+          }
+        }),
+      };
+      const prepare = SshTunnel.prepareRemoteRuntime(target, {}, {
+        archiveVersion: version, archiveDirectory: state.directory,
+      }).pipe(
+        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, state.spawner),
+        Effect.provideService(FileSystem.FileSystem, observedFs),
+      );
+      const first = yield* Effect.forkChild(prepare);
+      yield* Deferred.await(barrier.entered);
+      const second = yield* Effect.forkChild(prepare);
+      yield* Deferred.await(barrier.secondProbe);
+      // Download has only partial staging bytes; neither public cache file exists.
+      assert.isFalse(yield* state.fs.exists(archivePath));
+      assert.isFalse(yield* state.fs.exists(sidecarPath));
+      yield* Deferred.succeed(barrier.release, undefined);
+      yield* Fiber.join(first);
+      yield* Fiber.join(second);
+      assert.deepEqual(observed, ["sidecar", "archive"]);
+      assert.equal(state.calls.filter((call) => call === "gh").length, 1);
+      assert.deepEqual(state.uploads, [bytes, bytes]);
+      assert.deepEqual((yield* state.fs.readDirectory(state.directory)).sort(),
+        [asset, `${asset}.sha256`].sort());
+      assert.deepEqual(yield* state.fs.readFile(archivePath), bytes);
+      assert.equal(yield* state.fs.readFileString(sidecarPath), `${sha256}  ${asset}\n`);
+      yield* assertCleanStaging(state);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+
+  it.effect("timeout closes gh scope and removes staging without publication", () =>
+    Effect.gen(function* () {
+      const fs = yield* FileSystem.FileSystem;
+      const root = yield* fs.makeTempDirectoryScoped();
+      const entered = yield* Deferred.make<void>();
+      let closed = false;
+      const spawner = ChildProcessSpawner.make(() => Effect.gen(function* () {
+        yield* Scope.addFinalizer(yield* Scope.Scope, Effect.sync(() => { closed = true; }));
+        yield* Deferred.succeed(entered, undefined);
+        return { ...processHandle(), exitCode: Effect.never };
+      }));
+      const download = yield* Effect.forkChild(Effect.result(
+        downloadRuntimeArchiveWithGh(root, version, "linux-x64").pipe(
+          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
+        ),
+      ));
+      yield* Deferred.await(entered);
+      yield* TestClock.adjust(Duration.millis(300_001));
+      const result = yield* Fiber.join(download);
+      assert.isTrue(Result.isFailure(result));
+      if (Result.isFailure(result)) {
+        assertContext(result.failure, root);
+        assert.include(result.failure.message, "timed out");
+      }
+      assert.isTrue(closed);
+      assert.deepEqual(yield* fs.readDirectory(root), []);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+});
```

### `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/fixtures/remote-runner-baseline.json` — MODIFY

The baseline has 17 lines / 144,473 bytes, with each script stored on one long JSON line. Apply exactly six literal substring hunks below: one each inside `archive.runner`, `archive.launch`, `archive.pairing`, `node.runner`, `node.launch`, and `node.pairing`. `node.*` still contains the archive branch after its early node execution branch, so the default URL changes there even though acquisition is not used in node mode. `mirror.*` is unchanged.

```diff
-T3_RELEASE_BASE_URL='https://github.com/pingdotgg/t3code/releases/download'\n
+T3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\n
```

Copy-paste this in parent B from the source root. It performs that exact edit without regenerating or reformatting other bytes (NOT RUN here):

```sh
python3 - <<'FIXTURE'
from pathlib import Path
import json
p = Path("packages/ssh/src/fixtures/remote-runner-baseline.json")
old = "https://github.com/pingdotgg/t3code/releases/download"
new = "https://github.com/goat-si/goat/releases/download"
text = p.read_text()
data = json.loads(text)
assert text.count(old) == 6
for kind, item in data.items():
    for field, value in item.items():
        assert value.count(old) == (0 if kind == "mirror" else 1)
updated = text.replace(old, new)
next_data = json.loads(updated)
assert next_data["mirror"] == data["mirror"]
for kind in ("archive", "node"):
    for field, value in data[kind].items():
        assert next_data[kind][field] == value.replace(old, new)
p.write_text(updated)
FIXTURE
```

The existing `preserves ordinary runner, launch and pairing script bytes` test calls `nativeScripts()` through a native Node child because Vite rewrites Function.toString. It compares runner/launch/pairing bytes for archive/mirror/node inputs both with and without archiveDirectory. The upload patch checks unchanged bytes outside the acquisition anchors and leaves the managed runner unchanged. The test never rewrites the fixture. A later managed-server test consumes baseline.archive.launch and verifies persisted runner/process reuse. Do not regenerate these scripts via Vite or a broad formatter: only these six URL literal substitutions belong to wp2. wp4 must revalidate its larger intentional archive/executable changes separately.

## Conditional activation and acceptance

| Condition                        | Activation in focused test                                                                    | Observable proof                                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| gh success                       | cold linux-x64 and empty cache; fake writes binary bytes and uppercase binary-mode SHA256SUMS | probe → gh → upload → launch/pairing/MCP; archive bytes match input; exact sidecar persisted; GH_PROMPT_DISABLED=1; temp removed                     |
| missing release/auth/asset at gh | exit 1 for all three entrypoints                                                              | contextual SshLaunchError; only probe/gh; no remote runner/upload/session executes                                                                   |
| missing executable / A10         | real Node spawner with child PATH pointing to an empty temporary directory; SSH remains fake  | gh not found on PATH contextual error from real ENOENT; no archive/sidecar/upload/runner; no global env mutation                                     |
| ghCommand override               | spaced executable path supplied through RemoteT3RunnerOptions                                 | fake process acquisition succeeds, cache bytes persist and upload succeeds                                                                           |
| diagnostic stderr / A3           | failed gh emits long stderr with ANSI, controls and a token                                   | public error includes authentication failure and redaction; no controls/token; bounded tail; no upload                                               |
| checksum mismatch                | zero digest versus real bytes                                                                 | SHA-256 mismatch, no publication/upload/launch and empty cache                                                                                       |
| missing/malformed manifest entry | manifest has no valid matching asset                                                          | error before publication/upload                                                                                                                      |
| asset missing after gh exit 0    | SHA256SUMS exists but archive absent                                                          | error before publication/upload                                                                                                                      |
| timeout                          | fake exitCode never completes; Deferred marks spawn and TestClock advances                    | scope finalizer executes; temp removed; cache empty; contextual timeout                                                                              |
| explicit mirror                  | cold host/empty cache/nonblank mirror                                                         | probe → launch; no gh; existing real file:// test proves actual remote install                                                                       |
| ready host                       | probe ready=true                                                                              | no gh/upload; existing managed runner test proves runner and process preservation                                                                    |
| cached local build               | actual cache bytes, no sidecar                                                                | upload then launch, no gh; D9 unpublished-build path preserved                                                                                       |
| cached gh artifact / A2          | valid sidecar beside archive                                                                  | verified upload then launch; gh never invoked                                                                                                        |
| cached tampering / A2            | same-size changed archive or malformed sidecar                                                | fail before gh/upload/launch; mirror cannot bypass invalid cached checksum                                                                           |
| racing preparation / A13         | two prepareRemoteRuntime fibers; Deferred blocks partial staged download                      | canonical paths absent while staging partial; sidecar-first whole-file renames observed; one gh, one valid cached archive+sidecar, two exact uploads |
| server mirror / A3               | actual server config resolver with absent, empty, whitespace and nonblank env                 | real generated runner uses trimmed mirror only when nonblank; normal default otherwise; cache dir default and keepExistingRunner retained            |
| blank mirror                     | whitespace override with missing release                                                      | gh fails and remote download cannot execute                                                                                                          |
| missing directory                | cold default runner lacks archiveDirectory                                                    | probe then contextual error, no gh/runner                                                                                                            |
| unsupported platform             | darwin-x64                                                                                    | probe then contextual error identifying unsupported asset, no gh/runner                                                                              |
| node runner                      | existing NODE_SCRIPT tests                                                                    | archive preparation skipped; existing node timeout/launch behavior preserved                                                                         |

Tests assert outcomes and process boundaries, not UI callback wiring or implementation helper calls. The new suite executes real checksum parsing, hashing, cache rename and SSH payload construction with an injected external-process service; the established tunnel suite supplies real shell upload and mirror extraction proof. No new timer sleeps/polling are added. Timeout uses TestClock and Deferred. This subsystem is library process/filesystem work, not an orchestration outbox change; an effect-worker drain is not applicable.

## D4 limitation and surface coverage

Shared-helper consumers require no edit: `apps/server/src/cli/update.ts` calls cliReleaseIndexPageUrl; `apps/server/src/cloud/pinnedRuntime.ts` calls cliReleaseDownloadBaseUrl (used by selfUpdate.ts/bootService.ts); `apps/mobile/src/features/settings/environment-maintenance.ts` calls cliReleaseIndexPageUrl. They inherit GOAT URLs. They still use anonymous HTTP and may fail against a private repo. Explicit mirrors retain their currently wired behavior; the release index still ignores T3CODE_RELEASE_BASE_URL. This unit does not claim these flows can authenticate private releases.

- Entry points: launch, pairing and MCP cold-session acquisition included; public MCP names/provider key belong to wp3/wp6.
- Clients: shared SSH serves desktop and server dispatch, including remote agent calls. Web release notes retargeted. Mobile updater inherits shared URLs with D4's anonymous limitation.
- Providers/contracts: acquisition is provider-independent; no adapter or wire-schema field is added. Error channel widening stays internal and existing manager union already accepts SshLaunchError.
- Reverse/connection states: cache/ready reuse and scoped cleanup included; local/remote/relay clients use the environment doing SSH. Only archive bytes cross SSH; gh credentials remain local.
- Docs source-of-truth: amend D1/D2/D3 text in 000_plan as above; no feature catalog or new internal page. The requested plan remains local working material and is not an authorization to commit it.

The check is E7 code behavior in the default SSH preparation call path, with tests and rg scans as E7 early warnings. Known bypasses: executing a generated shell runner directly, D4 anonymous consumers and an explicitly supplied mirror. Residual risk: private release access remains unresolved for those D4 consumers. Wording is limited to default SSH preparation, not universal authenticated GitHub access enforcement; final universal enforcement layer: none.

## Exact verification commands (parent C only)

All commands below are **NOT RUN** by this leaf; explicit packet restrictions override verifier pre-execution defaults. Run each test block from its owning package directory, using package-relative file paths as in 020; run the subsequent typecheck/syntax block and stale-name gates from `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename`. Do not substitute repo-wide checks, builds, installs, servers or real network release acquisition.

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared
vp test run --config ../../vite.config.ts --dir . src/cliRelease.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh
vp test run --config ../../vite.config.ts --dir . src/runtimeArchive.test.ts src/runtimeArchiveGh.test.ts src/tunnel.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server
vp test run src/sshRemote/SshRemoteDispatch.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts
vp test run --config ../vite.config.ts --dir . build-npm-platform-packages.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web
vp test run src/components/desktopUpdate.logic.test.ts src/components/desktopUpdate.toast.test.tsx src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
vp exec tsc -p packages/shared/tsconfig.json --noEmit
vp exec tsc -p packages/ssh/tsconfig.json --noEmit
vp exec tsc -p apps/server/tsconfig.json --noEmit
vp exec tsc -p scripts/tsconfig.json --noEmit
vp exec tsc -p apps/web/tsconfig.json --noEmit
vp run --filter @t3tools/marketing typecheck
sh -n scripts/install.sh
bash -n packaging/aur/scripts/release.sh packaging/aur/t3code-bin/PKGBUILD packaging/aur/t3code-nightly-bin/PKGBUILD
```

Expected exit 0 for each. Every test path is explicit. Server and web use their owning package test configuration. Config-less shared/ssh/scripts packages explicitly select the root vite.config.ts with `--dir .`, matching their package.json test recipes; that config selects Node environment and excludes vendored/runtime/generated paths. Typecheck grounding: shared and ssh tsconfigs include `src`; scripts tsconfig includes `**/*.ts`; web tsconfig include contains `src`. Marketing package.json declares `typecheck: astro check` and depends on shared; docs/operations/development.md documents `vp run --filter <package> typecheck`. These commands observe the modified TS scope; shell syntax checks observe scripts only. They do not prove actual private-release access, PowerShell runtime behavior, AUR publication or real SSH installation. Record unavailable/not-run evidence distinctly. Existing real-shell tunnel tests retain their host-specific Windows skips; new tests need no gh installation or credentials; the minimal-PATH test uses real Node spawn with an isolated child environment and fake SSH, while other acquisition tests inject external processes. Parent must check actual Windows ENOENT translation in the focused suite, not infer it from a filesystem failure.

No new tests for static shell/marketing string assignments are needed; their exact hunks and stale-name gate are the smallest proof. No browser/computer-use verification is authorized or needed here. AUR release.sh must not be run merely to refresh metadata: no checked-in .SRCINFO files exist in this source tree.

Stale-name gate for the bounded release producer/assertion set:

```sh
rg -n 'pingdotgg/t3code' packages/shared/src/cliRelease.ts packages/shared/src/cliRelease.test.ts packages/ssh/src/tunnel.ts packages/ssh/src/tunnel.test.ts packages/ssh/src/runtimeArchiveGh.ts packages/ssh/src/runtimeArchiveGh.test.ts packages/ssh/src/fixtures/remote-runner-baseline.json scripts/install.sh scripts/install.ps1 packaging/aur/scripts/release.sh packaging/aur/t3code-bin/PKGBUILD packaging/aur/t3code-nightly-bin/PKGBUILD apps/marketing/src/lib/releases.ts scripts/build-npm-platform-packages.ts scripts/build-npm-platform-packages.test.ts apps/web/src/components/desktopUpdate.logic.ts apps/web/src/components/desktopUpdate.logic.test.ts apps/web/src/components/desktopUpdate.toast.test.tsx apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx
```

Expected **empty stdout / exit 1** (rg's normal no-match status); exit 2 is an error. Broad repo scans are informational and allow unrelated GitHub PR fixtures/test data, upstream issue comments, ModelManifest.ts, triage/source links, marketing site.ts, desktop metadata, preview workflow prose and package repository provenance outside D1. Do not blindly change those.

```sh
rg -n 'goat-si/goat|CLI_RELEASE_REPOSITORY' packages/shared/src/cliRelease.ts packages/ssh/src/runtimeArchiveGh.ts packages/ssh/src/tunnel.ts scripts/install.sh scripts/install.ps1 packaging/aur/scripts/release.sh apps/marketing/src/lib/releases.ts apps/web/src/components/desktopUpdate.logic.ts
rg -n 'downloads from an explicit mirror|PROTOCOL_ARCHIVE' packages/ssh/src/tunnel.test.ts
rg -n 'verified gh archive|missing release|mismatch|mirror|missing supported' packages/ssh/src/runtimeArchiveGh.test.ts
```

Expected nonempty stdout / exit 0: GOAT definitions/imports/diagnostics, explicit mirror protocol cases, behavior scenario names. Presence scans are early warnings; tests prove behavior.

## Risks and rollback

- No release may exist for this GOAT version. gh fails clearly rather than publishing/retrying anonymously. D9 can still use a locally built archive without SHA256SUMS. Cache hits without a sidecar deliberately trust local build bytes and hash them for SSH transport; cache hits with a sidecar validate it and fail before upload when invalid.
- The local gh subprocess inherits the local authenticated environment and keychain; it never receives SSH password helper env. Its argv is an array with shell=false and stdin ignored, so a spaced directory is preserved without quoting. Public errors include repo/tag/asset/archive dir and actionable local guidance plus a bounded sanitized stderr tail; the cause retains only exit code and that sanitized diagnostic, and stdout is empty.
- Staging is scoped and located inside archiveDirectory to guarantee same-filesystem atomic rename. Never replace with system /tmp plus cross-device copying. Within one process, the per-path keyed lock and second cache check coalesce races. Sidecar-first publication prevents a newly downloaded archive being misclassified as a no-sidecar local build. Separate processes still have atomic files, but replacing a release with different bytes concurrently is outside this same-process race proof; parent must report any stronger coordination requirement. If Windows contention prevents replacement, surface the contextual error; no unverified or partial canonical file is acceptable.
- File/hash/spawn/digest failures are mapped to SshLaunchError. Timeout/interruption closes the scoped child and removes staging. The fake timeout test proves scope cleanup; NodeServices owns actual process termination. No null/error catch may authorize default remote download.
- These six default URL fixture changes are intentional. Replacing a persisted managed runner can restart a server: preserve keepExistingRunner, run-t3.sh, .install-complete and existing reuse behavior. Remote root moves to `~/.goat` in wp4 through mandatory D7-A; wp2 must not start a GOAT server against `~/.t3/userdata`.
- AUR URL retargeting keeps historical package versions/checksum pins; it is not proof of an available GOAT desktop asset. Anonymous install scripts/marketing/mobile/cloud remain D4 limitations. PowerShell execution requires a later Windows host.
- Before external use, parent can reverse only the exact MODIFY hunks and remove the two NEW module/test files through its reviewed patch workflow. No shared-branch reset, automatic cache deletion, remote data deletion or process restart. Reverse fixture substitutions exactly and repeat focused tests if reverting.
- Failed hypothesis to record if no authenticated asset exists: URL retargeting alone cannot solve a private-release 404. Evidence refuting this design is a present/authenticated release that local gh still cannot fetch, or verified cache bytes differing from uploaded bytes. Capture the exact stage/context before broadening auth scope.

## wp4/wp5 handoff and leaf evidence

wp4 changes cliArchiveFileName and shell executable/archive producers together. The new gh module/test derives asset names from that helper, so it follows the later rename; existing literal tar fixture and shell bytes still need wp4's coordinated update. The current plan intentionally uses real t3-* baseline names. wp5 can exercise the local-build upload path without a published release.

Reflection amendment: A2/A3/A10/A13 are now concrete hunks and behavioral tests. Added source anchors are runtimeArchive.ts:1–43, tunnel.ts:69–93 and 1092–1148, SshRemoteDispatch.ts:601–620, SshRemoteDispatch.test.ts:1–150 and desktop main.ts:124–137. A3 server source/test hunks expand the original planned file map within this assigned document; no implementation write scope expands. Execution remains NOT RUN.

Leaf proof: source was read with rg/sed; before anchors were asserted against source while generating these diffs; fixture counts were parsed read-only (archive=3, mirror=0, node=3). Only this plan file was written. No installs/builds/tests/servers/git mutations or child spawning occurred. Parent retains integration, verification, architect/reflection and FSM/goal ownership.
