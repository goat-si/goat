# 020 — Carry and acquire the SSH runtime (D2 / wp2)

Stale check @7476236e5 — amended 16/50 named hunks (content or coordinates/counts); all 50 before-images plus the standalone workflow snippet reverified. Source read-only; no builds/tests.

## Loop spec

- Archetype: satisfy-spec; parent owns P/A/B/C/D, goal and integration.
- Trigger: D2 (item 1), after wp1 install-before-switch; source rechecked on 2026-10-11 at post-item-2 HEAD `7476236e53c1cd1e2cd0a57be89c20e05130bc6f`.
- Goal: a packaged desktop and its agent/backend dispatch can install their own exact GOAT runtime on a cold host from read-only packaged bytes; development can populate its writable runtime archive cache explicitly.
- Non-goals: D3 identity/feed/home migration, D4 cross-version protocol reuse, app replacement, releases, pushes, live SSH, frontend changes. This leaf writes this document only; no source edits, tests, builds, branch-level git, SSH or child spawn; read-only `git rev-parse HEAD` confirms the source revision.
- Verifier: the owning-package commands in §8 and the behavior matrix in §7. All commands are NOT RUN under the delegation restriction; no exit code or passing gate is claimed.
- Stop: return the completed diff-level document to parent; implementation ends only after focused evidence and parent's independent review.
- Memory artifact: this file plus 000_plan.md/001_research.md; no persistent memory writes.
- Expected terminal outcomes: plan delivered; later parent PASS with behavior evidence, or explicit unresolved amendment. Workflow test success does not establish a hosted release run.
- Escalation: D9 default home decision, any failure to map packaged resources into WSL, missing native archive producer, or source moving after the pinned post-010 stale check. No implicit source/write expansion.
- Resources: bounded leaf, read-only source; consultation/reflection and independent A remain parent responsibilities. No grant for descendants.

## 1. Source boundary and dependency order

Implementation root: `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename` (parent reports branch `goat/ssh-runtime-supply`; read-only HEAD inspection confirms `7476236e53c1cd1e2cd0a57be89c20e05130bc6f`). All paths below are relative to that root. Every fenced unified-diff before-image was checked against these source bytes, with earlier proposed blocks applied only in memory. Coordinates/counts below reflect that application order. No proposed source patch was applied. If HEAD moves, repeat the stale check and preserve the candidate-verification boundary.

The **wp2 P post-010 stale check is complete at `7476236e5`**. Item 2 has landed: `RemoteT3RunnerOptions` still has no bundle field; `prepareRemoteRuntime` starts at source line 1163; it probes ready/retained state before local acquisition and uploads through `buildRemoteUploadScript`. Preserve the staged executable exact-version check, `run-t3.next.$$` verification before publication, function-replacer placeholder substitution, pairing/MCP retained-runner behavior and non-owner disconnect behavior. No item-2 runner/setup/installer code is replaced by the acquisition hunks.

Read `000_plan.md` and `001_research.md` first. D1 owns runner publication/restart and retained-runner rules; these hunks change acquisition only. D2 owns this unit. D3/D9 own default data-home identity. At this HEAD, preparation returns no replacement runner; callers retain their runner options. D4 may later change that contract; re-ground the acquisition block if it does. D5 owns all real build/install/dispatch evidence.

Ordered steps:

1. Add a read-only bundle input and mandatory bundle sidecar validation; change cold acquisition precedence.
2. Connect packaged desktop main, primary backend env and backend dispatch; map the WSL bundle path into its selected distro.
3. Add packaging inputs, resource staging, archive validation and packaged-resource validation.
4. Add host archive generation and normalize `build-exe --target host` to its existing native-host mode.
5. Reorder release producers through upload before common bundle waits; validate the disabled workflow as data, not by running it.
6. Add the behavior tests below, run targeted checks, inspect the frozen fixture, hand evidence to parent.

Source-of-truth sync: D2 in 000 already states the durable constraint; propose amendments in §10. Existing executable/types/tests own implementation detail. No new internal/user guide is required. This plan is not a proposed repository commit; parent owns any archival decision.

| Change   | Exact path                                                   | Purpose                                                   |
| -------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| MODIFY   | packages/ssh/src/tunnel.ts                                   | runner input and bundle → cache → gh acquisition          |
| MODIFY   | packages/ssh/src/runtimeArchive.ts                           | optional mandatory canonical sidecar for packaged input   |
| MODIFY   | packages/ssh/src/tunnel.test.ts                              | real-shell cold/prepared/retained behavior and precedence |
| MODIFY   | packages/ssh/src/runtimeArchive.test.ts                      | required sidecar missing/malformed/digest mismatch        |
| PRESERVE | packages/ssh/src/fixtures/remote-runner-baseline.json        | all nine baseline entries unchanged by D2                 |
| MODIFY   | apps/desktop/src/main.ts                                     | resourcesPath bundle creation in packaged mode            |
| MODIFY   | apps/desktop/src/ssh/desktopSshCliRunner.ts                  | bundle field passes through runner options                |
| MODIFY   | apps/desktop/src/ssh/desktopSshCliRunner.test.ts             | packaged/dev runner resolution                            |
| MODIFY   | apps/desktop/src/backend/DesktopBackendConfiguration.ts      | backend child env; WSL path translation                   |
| MODIFY   | apps/desktop/src/backend/DesktopBackendConfiguration.test.ts | primary and WSL child config behavior                     |
| MODIFY   | apps/server/src/sshRemote/SshRemoteDispatch.ts               | deserialize bundle env                                    |
| MODIFY   | apps/server/src/sshRemote/SshRemoteDispatch.test.ts          | env whitespace/default/custom-cache cases                 |
| MODIFY   | scripts/build-desktop-artifact.ts                            | input chain, stage/validate/copy resource set             |
| MODIFY   | scripts/build-desktop-artifact.test.ts                       | real tar/filesystem payload proofs                        |
| MODIFY   | apps/server/scripts/cli.ts                                   | accept host sentinel without a cross-target download      |
| NEW      | scripts/dev-runtime-archive.ts                               | native host build orchestration and cache publication     |
| NEW      | scripts/dev-runtime-archive.test.ts                          | real child-process isolated-HOME orchestration            |
| NEW      | scripts/release-desktop-runtime.test.ts                      | workflow graph/input contract and wait-script behavior    |
| MODIFY   | package.json                                                 | dev:runtime-archive entry                                 |
| MODIFY   | .github/workflows/release-desktop.yml                        | producer-first archive flow, then package                 |
| DELETE   | none                                                         | no runtime or install removal                             |

Field chain: `bundledArchiveDirectory` is created in desktop main from `environment.resourcesPath`, passed through `resolveDesktopSshCliRunner`, consumed by `prepareRemoteRuntime` (desktop manager, pairing and MCP all already call it). Primary child serializes the same path as `T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR`; WSL serializes a translated path; `resolveSshCliRunner` trims/deserializes it and passes it to the same manager. This is process-local configuration: no WebSocket schema, persisted settings, JSON reviver, or renderer serialization. CLI packaging fields flow Flag → BuildCliInput / BuildEnvConfig → ResolvedBuildOptions → stage helper → createBuildConfig extraResources → packaged-resource validation. No empty-string env value creates a bundle path. Scripts' new home input flows Flag → worktree/ambient/default resolver → runtime/archives; it never opens a database.

## 2. Acquisition hunks

Policy: remote ready/retained-ready precedes every local archive read; then bundle; then user cache; then local gh into user cache; then upload. An explicit mirror remains the existing opt-in fallback if neither local source has the archive. A corrupt existing bundle is an error, not a silent cache/mirror fallback. A missing bundle asset falls through. A bundle alone can upload with no writable cache. A bundle path is never passed to gh or any filesystem mutation. Bundle and cache may share a string only if a caller misconfigures them; reject that equality before attempting gh (see hunk).

Apply these hunks from the implementation root with your usual patch tool. They are proposed source changes, not execution evidence.

Composition with item 2: bundle lookup selects bytes/digest only → existing `buildRemoteUploadScript` uploads and runs the transient installer → the installer verifies SHA-256 and `goat --version == goat v<archiveVersion>` before promoting the runtime/marker → the launch or cold pairing/MCP entry point stages `run-t3.next.$$`, verifies that candidate with the same exact version and only then publishes it. Preparation never publishes a runner or restarts a server. A ready probe checks executable presence plus marker, not executable output; the candidate boundary supplies execution verification when replacing/creating a runner. Existing retained runners keep their selected version and are never replaced merely because the bundle contains a newer version.

### MODIFY `packages/ssh/src/runtimeArchive.ts`

```diff
--- a/packages/ssh/src/runtimeArchive.ts
+++ b/packages/ssh/src/runtimeArchive.ts
@@ -17,6 +17,7 @@
   directory: string,
   version: string,
   platformKey: CliArchivePlatformKey,
+  requireSidecar = false,
 ) {
   const fs = yield* FileSystem.FileSystem;
   const path = yield* Path.Path;
@@ -44,7 +45,21 @@
   }
   const sha256 = Hex.encode(yield* crypto.digest("SHA-256", bytes));
   const sidecarPath = `${filePath}.sha256`;
-  if (yield* fs.exists(sidecarPath)) {
+  const hasSidecar = yield* fs.exists(sidecarPath);
+  if (requireSidecar && !hasSidecar) {
+    return yield* new SshLaunchError({
+      message: `Bundled SSH runtime archive is missing its SHA-256 sidecar (${sidecarPath}). Rebuild or reinstall the desktop bundle.`,
+      stdout: "",
+    });
+  }
+  if (hasSidecar) {
-    const expected = parseChecksums(yield* fs.readFileString(sidecarPath)).get(fileName);
+    const sidecar = yield* fs.readFileString(sidecarPath);
+    const expected = parseChecksums(sidecar).get(fileName);
+    if (requireSidecar && sidecar !== `${sha256}  ${fileName}\n`) {
+      return yield* new SshLaunchError({
+        message: `Bundled SSH runtime archive requires a canonical matching SHA-256 sidecar (${sidecarPath}). Rebuild or reinstall the desktop bundle.`,
+        stdout: "",
+      });
+    }
     if (expected === undefined || sha256 !== expected) {
       return yield* new SshLaunchError({
```

### MODIFY `packages/ssh/src/tunnel.ts`

```diff
--- a/packages/ssh/src/tunnel.ts
+++ b/packages/ssh/src/tunnel.ts
@@ -86,7 +86,10 @@
    */
   readonly archiveVersion?: string | null;
   readonly releaseBaseUrl?: string | null;
+  /** Writable user cache; only this directory may receive gh downloads. */
   readonly archiveDirectory?: string | null;
+  /** Read-only packaged archives. Never create, repair, or download into this directory. */
+  readonly bundledArchiveDirectory?: string | null;
   /** Local gh executable used for authenticated acquisition; defaults to PATH lookup. */
   readonly ghCommand?: string | undefined;
   /**
@@ -1170,9 +1173,10 @@
     const mayRetainRunner = runner?.keepExistingRunner && stateKey !== undefined;
     if (isNodeScriptRunner(runner) && !mayRetainRunner) return;
     const directory = runner?.archiveDirectory?.trim() ?? "";
+    const bundleDirectory = runner?.bundledArchiveDirectory?.trim() ?? "";
     const mirror = runner?.releaseBaseUrl?.trim() ?? "";
     // Explicit mirrors retain the existing path without a local cache.
-    if (directory === "" && mirror !== "" && !mayRetainRunner) return;
+    if (directory === "" && bundleDirectory === "" && mirror !== "" && !mayRetainRunner) return;
     const version = runner?.archiveVersion?.trim() ?? "";
     yield* Effect.annotateCurrentSpan({
       "ssh.target": target.alias,
@@ -1206,7 +1210,7 @@
       return;
     }
     const platformKey = cliArchivePlatformKey(probe.platform, probe.arch);
-    if (platformKey === undefined || directory === "") {
+    if (platformKey === undefined) {
       if (mirror !== "") {
         yield* Effect.annotateCurrentSpan("t3.runtime.source", "download");
         return;
@@ -1220,16 +1224,34 @@
         stdout: "",
       });
     }
-    const localArchive = yield* readLocalRuntimeArchive(directory, version, platformKey).pipe(
-      Effect.mapError(runtimePreparationError),
-    );
-    if (localArchive === null && mirror !== "") {
+    const bundledArchive = bundleDirectory === ""
+      ? null
+      : yield* readLocalRuntimeArchive(bundleDirectory, version, platformKey, true).pipe(
+          Effect.mapError(runtimePreparationError),
+        );
+    const localArchive = bundledArchive !== null || directory === ""
+      ? null
+      : yield* readLocalRuntimeArchive(directory, version, platformKey).pipe(
+          Effect.mapError(runtimePreparationError),
+        );
+    if (bundledArchive === null && localArchive === null && mirror !== "") {
       yield* Effect.annotateCurrentSpan("t3.runtime.source", "download");
       return;
     }
-    const archive =
-      localArchive ??
+    if (bundledArchive === null && localArchive === null) {
+      const path = yield* Path.Path;
+      if (directory === "" || (bundleDirectory !== "" && path.resolve(directory) === path.resolve(bundleDirectory))) {
+        return yield* new SshLaunchError({
+          message: `Cannot acquire ${cliArchiveFileName(version, platformKey)} for ${target.alias}: no writable user archive cache distinct from the bundle. Configure archiveDirectory or rebuild the packaged archives.`,
+          stdout: "",
+        });
+      }
+    }
+    const archive = bundledArchive ?? localArchive ??
       (yield* downloadRuntimeArchiveWithGh(directory, version, platformKey, runner?.ghCommand));
+    yield* Effect.annotateCurrentSpan(
+      "t3.runtime.acquisition", bundledArchive !== null ? "bundle" : localArchive !== null ? "cache" : "gh",
+    );
     yield* Effect.annotateCurrentSpan({
       "t3.runtime.source": "upload",
       "t3.runtime.upload.bytes": archive.bytes.byteLength,
```

The equality check is an early warning (E7 service code), not an assertion that application bundles are unwriteable. Executing surface: `prepareRemoteRuntime`; known bypass: directly calling `downloadRuntimeArchiveWithGh`, constructing aliased paths/symlinks, or running a generated mirror installer outside this entry point. Residual risk: user-configured filesystem aliases. Runtime correctness rests on never selecting `bundledArchiveDirectory` as a destination in normal creators; tests instrument writes. No new broad security mechanism is needed.

## 3. Desktop and backend wiring

### MODIFY `apps/desktop/src/ssh/desktopSshCliRunner.ts`

```diff
--- a/apps/desktop/src/ssh/desktopSshCliRunner.ts
+++ b/apps/desktop/src/ssh/desktopSshCliRunner.ts
@@ -16,7 +16,9 @@
     DesktopEnvironment.DesktopEnvironment["Service"],
     "appVersion" | "isPackaged" | "isDevelopment" | "devRemoteT3ServerEntryPath"
   >,
-  archiveOptions: Pick<RemoteT3RunnerOptions, "archiveDirectory" | "releaseBaseUrl">,
+  archiveOptions: Pick<
+    RemoteT3RunnerOptions, "archiveDirectory" | "bundledArchiveDirectory" | "releaseBaseUrl"
+  >,
   serverPackage: { readonly version: string; readonly engines: { readonly node: string } },
 ): RemoteT3RunnerOptions => {
   const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteT3ServerEntryPath);
```

### MODIFY `apps/desktop/src/main.ts`

```diff
--- a/apps/desktop/src/main.ts
+++ b/apps/desktop/src/main.ts
@@ -117,6 +117,9 @@
             archiveDirectory: Option.getOrElse(config.sshRuntimeArchiveDir, () =>
               environment.path.join(environment.baseDir, "runtime", "archives"),
             ),
+            ...(environment.isPackaged
+              ? { bundledArchiveDirectory: environment.path.join(environment.resourcesPath, "ssh-runtime", "archives") }
+              : {}),
             ...(releaseBaseUrl === undefined ? {} : { releaseBaseUrl }),
           },
           serverPackageJson,
```

### MODIFY `apps/server/src/sshRemote/SshRemoteDispatch.ts`

```diff
--- a/apps/server/src/sshRemote/SshRemoteDispatch.ts
+++ b/apps/server/src/sshRemote/SshRemoteDispatch.ts
@@ -607,6 +607,10 @@
     const archiveDirectory = yield* Config.String("T3CODE_SSH_RUNTIME_ARCHIVE_DIR").pipe(
       Config.withDefault(baseDir + "/runtime/archives"),
     );
+    const bundledArchiveDirectory = yield* Config.String("T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR").pipe(
+      Config.withDefault(""),
+      Effect.map((value) => value.trim() || undefined),
+    );
     const releaseBaseUrl = yield* Config.String("T3CODE_RELEASE_BASE_URL").pipe(
       Config.withDefault(""),
       Effect.map((value) => value.trim() || undefined),
@@ -614,6 +618,7 @@
     return {
       archiveVersion: packageJson.version,
       archiveDirectory,
+      ...(bundledArchiveDirectory === undefined ? {} : { bundledArchiveDirectory }),
       ...(releaseBaseUrl === undefined ? {} : { releaseBaseUrl }),
       keepExistingRunner: true,
     } satisfies SshTunnel.RemoteT3RunnerOptions;
```

### MODIFY `apps/desktop/src/backend/DesktopBackendConfiguration.ts`

```diff
--- a/apps/desktop/src/backend/DesktopBackendConfiguration.ts
+++ b/apps/desktop/src/backend/DesktopBackendConfiguration.ts
@@ -601,6 +601,9 @@
       env: {
         ...backendChildEnvPatch(),
         ELECTRON_RUN_AS_NODE: "1",
+        T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR: environment.isPackaged
+          ? environment.path.join(environment.resourcesPath, "ssh-runtime", "archives")
+          : undefined,
         // The server names this launcher in commands it asks a person to run.
         T3CODE_CLI_PATH: Option.getOrUndefined(input.cliPath),
       },
@@ -722,6 +725,11 @@
   // changes between probing and spawning the backend.
   const runningDistro = preflight._tag === "Ready" ? preflight.runningDistro : null;
   const distroForConfig = runningDistro ?? input.distro;
+  const bundledArchiveDirectory = environment.isPackaged
+    ? yield* wslEnvironment.windowsToWslPath(
+        distroForConfig, environment.path.join(environment.resourcesPath, "ssh-runtime", "archives"),
+      )
+    : Option.none<string>();

   // Resolve the selected distro's IPv4 address. In mirrored mode the distro
   // reports a host interface, so use loopback instead; a failed probe also
@@ -754,8 +762,17 @@
   // their env-ids collide).
   const parentEnvWithoutT3Home: Record<string, string | undefined> = {};
   for (const [key, value] of Object.entries(process.env)) {
-    if (key === "T3CODE_HOME") continue;
+    if (key === "T3CODE_HOME" || key === "T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR") continue;
-    parentEnvWithoutT3Home[key] = value;
+    // mergeWslEnv preserves inherited suffixes; remove this owned variable
+    // before appending its already-translated Linux value as a bare name.
+    parentEnvWithoutT3Home[key] = key === "WSLENV"
+      ? value?.split(":").filter((entry) =>
+          getWslEnvEntryName(entry.trim()) !== "T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR",
+        ).join(":")
+      : value;
+  }
+  if (Option.isSome(bundledArchiveDirectory)) {
+    forwardedEnvNames.push("T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR");
   }
   const wslEnv = mergeWslEnv(parentEnvWithoutT3Home.WSLENV, forwardedEnvNames);

@@ -768,6 +785,11 @@
       ...parentEnvWithoutT3Home,
       ...backendChildEnvPatch(),
       ...forwardedEnv,
+      // wsl.exe receives Windows env; /mnt/... is already a Linux path. WSLENV
+      // forwards this value without /p, avoiding a second path conversion.
+      ...(Option.isSome(bundledArchiveDirectory)
+        ? { T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR: bundledArchiveDirectory.value }
+        : {}),
       ...(wslEnv !== undefined ? { WSLENV: wslEnv } : {}),
     },
     // env is already a complete process.env minus T3CODE_HOME; pass it
```

The primary's `undefined` env patch clears ambient packaged-resource paths in development. For WSL, do not forward a Windows path verbatim. Translation uses the same concrete distro as launch, and WSLENV forwards the resulting Linux string without `/p`. A failed translation leaves the bundle input absent and uses the Linux backend's cache/gh path. The hunk removes this variable from ambient WSLENV before adding its Linux path, so an old `/p` suffix cannot convert it a second time; other entries are preserved. Test this explicitly. This is a Windows compatibility detail, not permission to write into packaged resources.

**Audit blocker 7 fold:** `DesktopBackendConfiguration.ts`'s `mergeWslEnv` (~149) detects names but preserves existing WSLENV entries and their suffixes. Removing the ambient variable value alone does not remove `T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR/p` from WSLENV. The parent-env hunk above filters **all** entries whose name before the first slash matches this variable, including bare entries, duplicates and `/p`, `/l`, `/u`, `/w` or combined flags, before calling `mergeWslEnv`. Append exactly one bare name only when translation succeeds. Cleanup also applies when translation fails or the app is unpackaged; unrelated entries, suffixes and empty segments remain intact.

## 4. Packaging inputs, staging and validation

Local builds may omit a bundle entirely for existing developer flows; when supplied, a nonempty subset of the three SSH keys is accepted (the supported native host archive is sufficient). `CI=true` or `--require-all-ssh-runtimes` requires a directory containing all three exact-version archives. Release workflow sets the explicit flag, so absence of CI detection cannot weaken it. Missing/malformed existing sidecars fail; missing source sidecars are canonicalized from verified staged bytes. Packaged sidecars are always `<sha256>  <archive-basename>\n`, never the WSL raw-digest format.

The archive version must equal the packaged server version (the `apps/server/package.json` version embedded in the built server and desktop bundle), as well as the desktop app version. When a bundle is supplied, reject a differing `--version`/`T3CODE_DESKTOP_VERSION` before staging; naming an archive with a desktop-only version override cannot change an embedded server version. Release jobs must stamp package versions before building. Cross-platform packaging checks filename/stem/layout; item 2 checks the executable's exact version on the target before installation/publication.

Validation must read the stage, then the actual packaged resource directory: filename/version, canonical sidecar, digest, tar layout, executable, web client, resource monitor and node-pty. It must not execute a Linux binary on macOS or cross-build Linux archives on macOS.

### MODIFY `scripts/build-desktop-artifact.ts`

```diff
--- a/scripts/build-desktop-artifact.ts
+++ b/scripts/build-desktop-artifact.ts
@@ -15,6 +15,7 @@
   type DirectoryRecord,
 } from "@electron/asar";

+import { cliArchiveFileName, cliArchiveTarCommand, parseChecksums } from "@t3tools/shared/cliRelease";
 import { fromYaml } from "@t3tools/shared/schemaYaml";
 import * as HostProcess from "@t3tools/shared/HostProcess";
 import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
@@ -182,6 +183,8 @@
   readonly mockUpdates: Option.Option<boolean>;
   readonly mockUpdateServerPort: Option.Option<number>;
   readonly wslRuntime: Option.Option<string>;
+  readonly sshRuntimeArchiveDir: Option.Option<string>;
+  readonly requireAllSshRuntimes: Option.Option<boolean>;
 }

 function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
@@ -939,6 +942,8 @@
   readonly mockUpdates: boolean;
   readonly mockUpdateServerPort: number | undefined;
   readonly wslRuntime: string | undefined;
+  readonly sshRuntimeArchiveDir: string | undefined;
+  readonly requireAllSshRuntimes: boolean;
 }

 interface StagePackageJson {
@@ -986,6 +991,8 @@
   // staging inputs out of app.asar; they are emitted once at resources/.
   "!apps/desktop/prod-resources/windows-server",
   "!apps/desktop/prod-resources/windows-server/**/*",
+  "!apps/desktop/prod-resources/ssh-runtime",
+  "!apps/desktop/prod-resources/ssh-runtime/**/*",
   "!apps/desktop/prod-resources/wsl-runtime.tar.gz",
   "!apps/desktop/prod-resources/wsl-runtime.tar.gz.sha256",
   "!apps/desktop/gnome-extension",
@@ -1682,6 +1689,9 @@
   // by the build_linux_cli CI job. The Windows build embeds it verbatim as the
   // WSL runtime.
   wslRuntime: Config.String("T3CODE_DESKTOP_WSL_RUNTIME").pipe(Config.option),
+  sshRuntimeArchiveDir: Config.String("T3CODE_DESKTOP_SSH_RUNTIME_ARCHIVE_DIR").pipe(Config.option),
+  requireAllSshRuntimes: Config.Boolean("T3CODE_DESKTOP_REQUIRE_ALL_SSH_RUNTIMES").pipe(Config.withDefault(false)),
+  ci: Config.Boolean("CI").pipe(Config.withDefault(false)),
 });

 const MockUpdateServerPortSchema = Schema.NumberFromString.check(
@@ -1789,6 +1799,8 @@
     mockUpdates,
     mockUpdateServerPort,
     wslRuntime,
+    sshRuntimeArchiveDir: (Option.getOrUndefined(input.sshRuntimeArchiveDir) ?? Option.getOrUndefined(env.sshRuntimeArchiveDir))?.trim() || undefined,
+    requireAllSshRuntimes: env.ci || resolveBooleanFlag(input.requireAllSshRuntimes, env.requireAllSshRuntimes),
   } satisfies ResolvedBuildOptions;
 });

@@ -2765,6 +2777,7 @@
   // source file was never written fails the electron-builder step.
   wslRuntimeBundled = false,
   arch?: typeof BuildArch.Type,
+  sshRuntimeBundled = false,
 ) {
   const buildConfig: Record<string, unknown> = {
     appId: DESKTOP_APP_ID,
@@ -2790,6 +2803,7 @@
       : {}),
     extraResources: [
       ...DESKTOP_EXTRA_RESOURCES,
+      ...(sshRuntimeBundled ? SSH_RUNTIME_EXTRA_RESOURCES : []),
       ...(platform === "linux" ? LINUX_CAPTURE_EXTRA_RESOURCES : []),
       ...(platform === "linux" ? LINUX_BROWSER_SECRET_EXTRA_RESOURCES : []),
       ...(platform === "win" ? WINDOWS_SERVER_EXTRA_RESOURCES : []),
@@ -3028,6 +3042,106 @@
     .map((member) => member.replace(/^\.\//, "").replace(/\/$/, ""))
     .filter((member) => member.length > 0);

+
+export const SSH_RUNTIME_PLATFORM_KEYS = ["darwin-arm64", "linux-x64", "linux-arm64"] as const;
+export const SSH_RUNTIME_RESOURCE_SOURCE_DIR = "apps/desktop/prod-resources/ssh-runtime/archives";
+export const SSH_RUNTIME_EXTRA_RESOURCES = [{
+  from: SSH_RUNTIME_RESOURCE_SOURCE_DIR,
+  to: "ssh-runtime/archives",
+  filter: ["*.tar.gz", "*.tar.gz.sha256"],
+}] as const;
+
+export const validateSshRuntimeArchives = Effect.fn("validateSshRuntimeArchives")(function* (input: {
+  readonly directory: string;
+  readonly version: string;
+  readonly requireAll: boolean;
+  readonly requireSidecars?: boolean;
+}) {
+  const fs = yield* FileSystem.FileSystem;
+  const path = yield* Path.Path;
+  const archives: Array<{ fileName: string; bytes: Uint8Array; sha256: string }> = [];
+  for (const key of SSH_RUNTIME_PLATFORM_KEYS) {
+    const fileName = cliArchiveFileName(input.version, key);
+    const archivePath = path.join(input.directory, fileName);
+    if (!(yield* fs.exists(archivePath))) {
+      if (input.requireAll) return yield* Effect.fail(new Error(`Missing SSH runtime archive ${archivePath}`));
+      continue;
+    }
+    const stat = yield* fs.stat(archivePath);
+    if (stat.type !== "File" || stat.size > 256n * 1024n * 1024n) {
+      return yield* Effect.fail(new Error(`Invalid SSH runtime archive ${archivePath}`));
+    }
+    const bytes = yield* fs.readFile(archivePath);
+    if (BigInt(bytes.byteLength) !== stat.size || bytes.byteLength > 256 * 1024 * 1024) {
+      return yield* Effect.fail(new Error(`SSH runtime archive changed while reading ${archivePath}`));
+    }
+    const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
+    const sidecar = `${archivePath}.sha256`;
+    const hasSidecar = yield* fs.exists(sidecar);
+    if (input.requireSidecars && !hasSidecar) {
+      return yield* Effect.fail(new Error(`Missing SSH runtime checksum ${sidecar}`));
+    }
+    if (hasSidecar) {
+      const checksum = yield* fs.readFileString(sidecar);
+      if (parseChecksums(checksum).get(fileName) !== sha256 ||
+          (input.requireSidecars && checksum !== `${sha256}  ${fileName}\n`)) {
+        return yield* Effect.fail(new Error(`Invalid or noncanonical SSH runtime checksum ${sidecar}`));
+      }
+    }
+    const tarCommand = cliArchiveTarCommand(yield* HostProcess.Platform, process.env);
+    const listing = yield* spawnAndCollectOutput(ChildProcess.make(tarCommand, ["-tzf", archivePath], {
+      stdin: "ignore", stdout: "pipe", stderr: "pipe",
+    }));
+    if (listing.exitCode !== 0) {
+      return yield* Effect.fail(new Error(`Cannot list ${archivePath}: ${listing.stderr.trim()}`));
+    }
+    const members = parseWslRuntimeArchiveMembers(listing.stdout);
+    const stem = fileName.slice(0, -".tar.gz".length);
+    const required = [
+      `${stem}/goat`, `${stem}/client/index.html`,
+      `${stem}/resource-monitor/${key}/t3-resource-monitor`,
+    ];
+    const pty = [
+      `${stem}/node_modules/node-pty/build/Release/pty.node`,
+      `${stem}/node_modules/node-pty/prebuilds/${key}/pty.node`,
+    ];
+    if (members.length === 0 || members.some((member) =>
+      member.split("/").some((segment) => segment === "..") ||
+      (member !== stem && !member.startsWith(`${stem}/`)) || member.endsWith("/bin.mjs")) ||
+      required.some((member) => !members.includes(member)) || !pty.some((member) => members.includes(member))) {
+      return yield* Effect.fail(new Error(`Incomplete or wrong-version SSH runtime archive ${archivePath}`));
+    }
+    archives.push({ fileName, bytes, sha256 });
+  }
+  if (archives.length === 0) return yield* Effect.fail(new Error(`No SSH runtime archives for ${input.version} in ${input.directory}`));
+  return archives;
+});
+
+export const stageSshRuntimeArchives = Effect.fn("stageSshRuntimeArchives")(function* (input: {
+  readonly sourceDirectory: string;
+  readonly destinationDirectory: string;
+  readonly version: string;
+  readonly requireAll: boolean;
+}) {
+  const fs = yield* FileSystem.FileSystem;
+  const path = yield* Path.Path;
+  // Validate the entire input before creating any destination resources.
+  const archives = yield* validateSshRuntimeArchives({
+    directory: input.sourceDirectory, version: input.version, requireAll: input.requireAll,
+  });
+  yield* fs.makeDirectory(input.destinationDirectory, { recursive: true });
+  for (const archive of archives) {
+    // Write the bytes we hashed, not a second read/copy of a mutable source.
+    yield* fs.writeFile(path.join(input.destinationDirectory, archive.fileName), archive.bytes);
+    yield* fs.writeFileString(path.join(input.destinationDirectory, `${archive.fileName}.sha256`),
+      `${archive.sha256}  ${archive.fileName}\n`);
+  }
+  yield* validateSshRuntimeArchives({
+    directory: input.destinationDirectory, version: input.version,
+    requireAll: input.requireAll, requireSidecars: true,
+  });
+});
+
 // Stage and pack the Windows server sidecar: the bundled server plus a hoisted
 // install of only its runtime-external/native dependency closure for win32.
 // The Windows primary runs from the archive through the asar-aware
@@ -3609,6 +3723,12 @@
   });

   const appVersion = options.version ?? serverPackageJson.version;
+  if (options.sshRuntimeArchiveDir !== undefined && appVersion !== serverPackageJson.version) {
+    return yield* Effect.fail(new Error(`Bundled SSH runtime version ${appVersion} must equal packaged server version ${serverPackageJson.version}. Stamp package versions before building; do not use a desktop-only version override.`));
+  }
+  if (options.requireAllSshRuntimes && options.sshRuntimeArchiveDir === undefined) {
+    return yield* Effect.fail(new Error("CI/release desktop packaging requires --ssh-runtime-archive-dir with darwin-arm64, linux-x64 and linux-arm64 archives."));
+  }
   const iconAssets = resolveDesktopBuildIconAssets(appVersion);
   const commitHash = yield* resolveGitCommitHash(repoRoot);
   const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
@@ -3889,6 +4009,7 @@
         : undefined,
       bundlesWslRuntime({ platform: options.platform, runtimeArchivePath: options.wslRuntime }),
       options.arch,
+      options.sshRuntimeArchiveDir !== undefined,
     ),
     dependencies: stageDependencies,
     devDependencies: {
@@ -3960,6 +4081,14 @@
       sourceArchivePath: options.wslRuntime,
       archivePath: path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE.from),
       hashPath: path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE.from),
+    });
+  }
+
+  if (options.sshRuntimeArchiveDir !== undefined) {
+    yield* stageSshRuntimeArchives({
+      sourceDirectory: path.resolve(repoRoot, options.sshRuntimeArchiveDir),
+      destinationDirectory: path.join(stageAppDir, SSH_RUNTIME_RESOURCE_SOURCE_DIR),
+      version: appVersion, requireAll: options.requireAllSshRuntimes,
     });
   }

@@ -4150,6 +4279,12 @@
     Flag.withDescription("Mock update server port (env: T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
     Flag.optional,
   ),
+  sshRuntimeArchiveDir: Flag.String("ssh-runtime-archive-dir").pipe(
+    Flag.withDescription("Directory of exact-version SSH CLI archives to bundle read-only."), Flag.optional,
+  ),
+  requireAllSshRuntimes: Flag.Boolean("require-all-ssh-runtimes").pipe(
+    Flag.withDescription("Require darwin-arm64, linux-x64 and linux-arm64 (also mandatory when CI=true)."), Flag.optional,
+  ),
   wslRuntime: Flag.String("wsl-runtime").pipe(
     Flag.withDescription(
       "Path to the Linux CLI release archive (goat-<version>-linux-x64.tar.gz) to embed as the WSL runtime of a Windows build (env: T3CODE_DESKTOP_WSL_RUNTIME).",
```

Packaging helper uses existing `spawnAndCollectOutput`/`parseWslRuntimeArchiveMembers`, not a new SSH export or scripts dependency. Required monitor paths match `build-cli-archive --resource-monitor-dir`'s per-platform layout. GNU/bsdtar listing is read-only. The stage holds all three files in memory at most ~768 MiB; if this is material on a builder, validate/stage one archive at a time in two passes (first validate every file, then revalidate/hash while writing), keeping byte identity. Do not weaken the per-file 256 MiB limit.

Actual packaged validation is required in addition to the hunk above: determine the packaged app/resource directory using the existing electron-builder output paths, and call `validateSshRuntimeArchives({ directory: <actual resources>/ssh-runtime/archives, version: appVersion, requireAll: options.requireAllSshRuntimes, requireSidecars: true })` after electron-builder. §7 tests must exercise dropped/changed extraResources. The concrete post-builder hunk is below.

### MODIFY `scripts/build-desktop-artifact.ts`

```diff
--- a/scripts/build-desktop-artifact.ts
+++ b/scripts/build-desktop-artifact.ts
@@ -3407,6 +3407,38 @@
   );
 });

+export const validatePackagedSshRuntimeArchives = Effect.fn("validatePackagedSshRuntimeArchives")(function* (input: {
+  readonly stageDistDir: string;
+  readonly version: string;
+  readonly requireAll: boolean;
+}) {
+  const fs = yield* FileSystem.FileSystem;
+  const path = yield* Path.Path;
+  const resourceDirectories: string[] = [];
+  // electron-builder keeps an unpacked app next to installers. Visit only
+  // the output root and one platform directory, never a dependency tree.
+  for (const entry of yield* fs.readDirectory(input.stageDistDir)) {
+    const directory = path.join(input.stageDistDir, entry);
+    if ((yield* fs.stat(directory)).type !== "Directory") continue;
+    if (entry.endsWith("-unpacked")) resourceDirectories.push(path.join(directory, "resources"));
+    if (entry.endsWith(".app")) resourceDirectories.push(path.join(directory, "Contents", "Resources"));
+    if (entry === "mac" || entry.startsWith("mac-")) {
+      for (const app of yield* fs.readDirectory(directory)) {
+        if (app.endsWith(".app")) resourceDirectories.push(path.join(directory, app, "Contents", "Resources"));
+      }
+    }
+  }
+  if (resourceDirectories.length === 0) {
+    return yield* Effect.fail(new Error(`No packaged app resources found in ${input.stageDistDir}`));
+  }
+  for (const resources of resourceDirectories) {
+    yield* validateSshRuntimeArchives({
+      directory: path.join(resources, "ssh-runtime", "archives"),
+      version: input.version, requireAll: input.requireAll, requireSidecars: true,
+    });
+  }
+});
+
 export const validateWindowsPackagedPayload = Effect.fn(
   "desktopArtifact.validateWindowsPackagedPayload",
 )(function* (input: {
@@ -4197,6 +4229,12 @@
         runtimeArchivePath: options.wslRuntime,
       }),
       verbose: options.verbose,
+    });
+  }
+
+  if (options.sshRuntimeArchiveDir !== undefined) {
+    yield* validatePackagedSshRuntimeArchives({
+      stageDistDir, version: appVersion, requireAll: options.requireAllSshRuntimes,
     });
   }

```

Input test literals must acquire both new required Option fields. These are the only three `resolveBuildOptions` object literals in the current test file; preserve every existing assertion.

### MODIFY `scripts/build-desktop-artifact.test.ts`

```diff
--- a/scripts/build-desktop-artifact.test.ts
+++ b/scripts/build-desktop-artifact.test.ts
@@ -2373,6 +2373,8 @@
         mockUpdates: Option.none(),
         mockUpdateServerPort: Option.none(),
         wslRuntime: Option.none(),
+        sshRuntimeArchiveDir: Option.none(),
+        requireAllSshRuntimes: Option.none(),
       }).pipe(
         Effect.provide(
           Layer.mergeAll(
@@ -2413,6 +2415,8 @@
             mockUpdates: Option.none(),
             mockUpdateServerPort: Option.none(),
             wslRuntime: Option.none(),
+        sshRuntimeArchiveDir: Option.none(),
+        requireAllSshRuntimes: Option.none(),
           }),
         );

@@ -2437,6 +2441,8 @@
         mockUpdates: Option.some(false),
         mockUpdateServerPort: Option.none(),
         wslRuntime: Option.none(),
+        sshRuntimeArchiveDir: Option.none(),
+        requireAllSshRuntimes: Option.none(),
       }).pipe(
         Effect.provide(
           ConfigProvider.layer(
```

## 5. Development archive command

`--target host` currently reaches `T3CODE_PACK_EXE_TARGET=host` and is rejected by apps/server/vite.config.ts. Normalize it at the existing CLI boundary; no SEA_TARGETS entry named host, no cross-target download, and no change to the root Node engine. Windows local generation can produce its Windows cache archive; it does not satisfy the three SSH release targets. Unsupported Darwin x64 generation fails before any build, as the shared CLI archive platform list has no darwin-x64.

Resolve home exactly as dev-runner: explicit `--home-dir` → linked worktree `.t3` → ambient T3CODE_HOME → current DEFAULT_T3_HOME. Import the existing DEFAULT_T3_HOME rather than hard-code ~/.goat or ~/.t3 here; D3/D9 must amend that owner consistently. Importing dev-runner is safe from CLI launch (`import.meta.main` guard), but does run its existing loadRepoEnv assignment, which the command also wants. No live userdata file is read/written. The embedded version and archive filename both use the server package version; this command has no independent version override.

SEA selection: honor explicit `--node-version` / VP_NODE_VERSION; otherwise use current process.version if >=25.7.0, or pinned 26.8.2. Probe the actual `vp exec node -p process.version` result first. A configured old or malformed version errors before builds. All vp children receive this exact selection and PATH, so the CLI's nested `vp pack` uses the same suitable Node. PATH must expose vp/cargo; tool failures propagate with exit/output. The script never installs a remote toolchain.

### MODIFY `apps/server/scripts/cli.ts`

```diff
--- a/apps/server/scripts/cli.ts
+++ b/apps/server/scripts/cli.ts
@@ -135,7 +135,9 @@
             T3CODE_PACK_EXE: "1",
             ...Option.match(config.target, {
               onNone: () => ({}),
-              onSome: (target) => ({ T3CODE_PACK_EXE_TARGET: target }),
+              onSome: (target) => target.trim() === "host"
+                ? ({ T3CODE_PACK_EXE_TARGET: "" })
+                : ({ T3CODE_PACK_EXE_TARGET: target }),
             }),
           },
           stdout: config.verbose ? "inherit" : "ignore",
```

### MODIFY `package.json`

```diff
--- a/package.json
+++ b/package.json
@@ -10,6 +10,7 @@
     "dev:web": "node scripts/dev-runner.ts dev:web",
     "dev:marketing": "vp run --filter @t3tools/marketing dev",
     "dev:desktop": "node scripts/dev-runner.ts dev:desktop",
+    "dev:runtime-archive": "node scripts/dev-runtime-archive.ts",
     "migrate-dev-db": "node apps/server/scripts/migrate-dev-db.ts",
     "start": "vp run --filter t3 start",
     "start:desktop": "vp run --filter @t3tools/desktop start",
```

### NEW `scripts/dev-runtime-archive.ts`

```diff
--- /dev/null
+++ b/scripts/dev-runtime-archive.ts
@@ -0,0 +1,127 @@
+#!/usr/bin/env node
+// @effect-diagnostics nodeBuiltinImport:off - Local build orchestration needs Node version and atomic filesystem publication.
+import * as NodeCrypto from "node:crypto";
+import * as NodeFSP from "node:fs/promises";
+import * as NodePath from "node:path";
+import * as NodeURL from "node:url";
+import * as NodeUtil from "node:util";
+import * as NodeChildProcess from "node:child_process";
+import * as NodeServices from "@effect/platform-node/NodeServices";
+import * as Effect from "effect/Effect";
+import * as Path from "effect/Path";
+import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
+import { resolveSpawnCommand } from "@t3tools/shared/shell";
+import { cliArchiveFileName, cliArchivePlatformKey } from "@t3tools/shared/cliRelease";
+import { DEFAULT_T3_HOME } from "./dev-runner.ts";
+import { validateSshRuntimeArchives } from "./build-desktop-artifact.ts";
+import serverPackageJson from "../apps/server/package.json" with { type: "json" };
+
+const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
+const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
+export const supportsSea = (version: string) => {
+  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
+  return match !== null && (Number(match[1]) > 25 || (Number(match[1]) === 25 && Number(match[2]) >= 7));
+};
+export const resolveRuntimeArchiveHome = (input: {
+  readonly cwd: string; readonly homeDir?: string; readonly ambientHome?: string;
+}) => Effect.gen(function* () {
+  const path = yield* Path.Path;
+  const worktreeHome = yield* resolveWorktreeT3Home(input.cwd);
+  return path.resolve(input.cwd, (input.homeDir?.trim() || undefined) ?? worktreeHome ??
+    (input.ambientHome?.trim() || undefined) ?? (yield* DEFAULT_T3_HOME));
+});
+
+export async function buildDevRuntimeArchive(input: {
+  readonly homeDir?: string;
+  readonly nodeVersion?: string;
+  readonly env?: NodeJS.ProcessEnv;
+  readonly cwd?: string;
+  readonly repoRoot?: string;
+}) {
+  const buildRoot = input.repoRoot ?? repoRoot;
+  const env = { ...(input.env ?? process.env) };
+  const platform = process.platform;
+  const arch = process.arch;
+  const key = cliArchivePlatformKey(platform, arch);
+  if (key === undefined) throw new Error(`No supported CLI archive for ${platform}-${arch}`);
+  const selection = input.nodeVersion?.trim() || env.VP_NODE_VERSION?.trim() ||
+    (supportsSea(process.version) ? process.version.slice(1) : "26.8.2");
+  if (!supportsSea(selection)) throw new Error(`SEA requires Node >=25.7.0; requested ${selection}`);
+  env.VP_NODE_VERSION = selection.replace(/^v/, "");
+  const vp = "vp";
+  const run = async (command: string, args: string[]) => {
+    const resolved = await Effect.runPromise(resolveSpawnCommand(command, args, { env })
+      .pipe(Effect.provide(NodeServices.layer)));
+    return execFile(resolved.command, resolved.args, {
+      cwd: buildRoot, env, maxBuffer: 16 * 1024 * 1024, shell: resolved.shell,
+    });
+  };
+  const probe = await run(vp, ["exec", "node", "-p", "process.version"]);
+  if (!supportsSea(probe.stdout)) throw new Error(`vp selected unsuitable SEA Node: ${probe.stdout.trim()}`);
+  const home = await Effect.runPromise(resolveRuntimeArchiveHome({
+    cwd: input.cwd ?? buildRoot, homeDir: input.homeDir, ambientHome: env.T3CODE_HOME,
+  }).pipe(Effect.provide(NodeServices.layer)));
+  const directory = NodePath.join(home, "runtime", "archives");
+  await NodeFSP.mkdir(directory, { recursive: true });
+  // Stage on the cache filesystem so final rename cannot be an EXDEV copy.
+  const staging = await NodeFSP.mkdtemp(NodePath.join(directory, ".goat-dev-"));
+  const publicationLock = NodePath.join(directory, `.goat-dev-${serverPackageJson.version}-${key}.lock`);
+  let locked = false;
+  try {
+    const monitor = NodePath.join(staging, "resource-monitor", key);
+    await NodeFSP.mkdir(monitor, { recursive: true });
+    // Server build task depends on @t3tools/web#build and stages dist/client.
+    await run(vp, ["run", "--filter", "t3", "build"]);
+    await run(vp, ["exec", "node", "apps/server/scripts/cli.ts", "build-exe", "--target", "host", "--verbose"]);
+    await run("cargo", ["build", "--locked", "--release", "--manifest-path", "native/resource-monitor/Cargo.toml"]);
+    const monitorName = platform === "win32" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
+    await NodeFSP.copyFile(NodePath.join(buildRoot, "native/resource-monitor/target/release", monitorName),
+      NodePath.join(monitor, monitorName));
+    await run(vp, ["exec", "node", "scripts/build-cli-archive.ts", "--platform", platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux",
+      "--arch", arch, "--version", serverPackageJson.version,
+      "--resource-monitor-dir", NodePath.dirname(monitor), "--output-dir", staging]);
+    const name = cliArchiveFileName(serverPackageJson.version, key);
+    const file = NodePath.join(staging, name);
+    const bytes = await NodeFSP.readFile(file);
+    const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
+    await NodeFSP.writeFile(`${file}.sha256`, `${hash}  ${name}\n`);
+    if (platform !== "win32") {
+      await Effect.runPromise(validateSshRuntimeArchives({
+        directory: staging, version: serverPackageJson.version, requireAll: false, requireSidecars: true,
+      }).pipe(Effect.provide(NodeServices.layer)));
+    }
+    // Sidecar first, archive last: readers fail closed during a replacement.
+    // Roll back the old sidecar if archive publication fails.
+    const finalFile = NodePath.join(directory, name);
+    await NodeFSP.mkdir(publicationLock).catch((cause: unknown) => {
+      throw new Error(`Another dev runtime publication owns ${publicationLock}; retry after it finishes.`, { cause });
+    });
+    locked = true;
+    const previousSidecar = await NodeFSP.readFile(`${finalFile}.sha256`).catch((cause: unknown) => {
+      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
+      throw cause;
+    });
+    await NodeFSP.rename(`${file}.sha256`, `${finalFile}.sha256`);
+    try {
+      await NodeFSP.rename(file, finalFile);
+    } catch (cause) {
+      if (previousSidecar === null) await NodeFSP.rm(`${finalFile}.sha256`, { force: true });
+      else await NodeFSP.writeFile(`${finalFile}.sha256`, previousSidecar);
+      throw cause;
+    }
+    return finalFile;
+  } finally {
+    if (locked) await NodeFSP.rmdir(publicationLock);
+    await NodeFSP.rm(staging, { recursive: true, force: true });
+  }
+}
+
+if (import.meta.main) {
+  const { values } = NodeUtil.parseArgs({ options: {
+    "home-dir": { type: "string" }, "node-version": { type: "string" },
+  } });
+  buildDevRuntimeArchive({ homeDir: values["home-dir"], nodeVersion: values["node-version"] }).then(
+    (archive) => console.log(`[dev-runtime-archive] ${archive}`),
+    (cause: unknown) => { console.error(cause); process.exitCode = 1; },
+  );
+}
```

The exact NEW file intentionally uses serverPackageJson.version for both build and archive. Stamping a filename independently of embedded executable version produces a lying runtime. A future explicit override needs an isolated version-stamped build tree and belongs to a separate request.

The publication is an atomic archive rename, with sidecar-first fail-closed behavior, not a two-file transaction. Concurrent same-version dev publications use the mkdir lock in the NEW file. The NEW file includes a publication mkdir lock; a concurrent publisher gets an actionable error rather than overwriting a second sidecar. A crash can leave that lock, which is not reclaimed automatically. Directory creation/staging is writable cache only; source build outputs are normal build outputs. D5 chooses when to run this command.

## 6. Release workflow reorder (disabled workflow; no activation)

The current workflow packages before `Build CLI single-executable` and uploads CLI assets only later. Move CLI producer steps (including signing, smoke and Upload CLI archive) before any bundle wait or desktop packaging. The producer currently relies on desktop packaging to build the resource monitor, so insert an explicit cargo build before its stage step. Cross-target hardware stays unchanged. The existing shared JS bundle already includes dist/client. All archive producers upload before waiting, preventing a Mac↔Linux circular dependency.

The following executable transformation is intentionally used for moving the long existing blocks without dropping their signing inputs. It only rewrites the named workflow when parent executes it; this leaf has not run it. The second block below is the exact new YAML inserted. Existing WSL wait/download stays after the common wait and before packaging, or can keep its redundant verification. Do not rename `cli-mac-arm64` to `cli-darwin-arm64`: artifact names use workflow platform input while archive basenames use Node platform keys.

```python
from pathlib import Path
p = Path('.github/workflows/release-desktop.yml')
s = p.read_text()
cli_start = s.index('      # The single-executable is built with a Node')
cli_end = s.index('      - name: Collect release assets', cli_start)
producer = s[cli_start:cli_end]
s = s[:cli_start] + s[cli_end:]
monitor_step = '      - name: Build resource monitor before CLI archive\n        if: inputs.cli_archive && steps.resource_monitor_cache.outputs.cache-hit != \'true\'\n        shell: bash\n        run: cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target "${{ inputs.rust_target }}"\n\n'
producer = producer.replace('      - name: Stage resource monitor for the CLI archive', monitor_step + '      - name: Stage resource monitor for the CLI archive', 1)
anchor = '      # The WSL backend runs the Linux CLI archive inside the distro'
s = s.replace(anchor, producer + COMMON_SSH_BUNDLE_STEPS + anchor, 1)
s = s.replace("timeout-minutes: ${{ inputs.platform == 'win' && 70 || 30 }}", 'timeout-minutes: 70', 1)
s = s.replace('            --skip-build\n            --verbose', '            --skip-build\n            --ssh-runtime-archive-dir "$GITHUB_WORKSPACE/ssh-runtime-archives"\n            --require-all-ssh-runtimes\n            --verbose', 1)
# COMMON_SSH_BUNDLE_STEPS is exactly the following YAML string.
p.write_text(s)
```

Define `COMMON_SSH_BUNDLE_STEPS` from this literal before running that transformation:

```yaml
- name: Wait for SSH runtime archives
  shell: bash
  timeout-minutes: 40
  env:
    GH_TOKEN: ${{ github.token }}
  run: |
    node --input-type=module <<'NODE'
    const required = new Map([
      ["cli-mac-arm64", "Build macOS arm64"],
      ["cli-linux-x64", "Build Linux x64"],
      ["cli-linux-arm64", "Build Linux arm64"],
    ]);
    const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" };
    const root = `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    const deadline = Date.now() + 35 * 60_000;
    async function get(url) {
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`Actions API ${response.status}`);
      return response.json();
    }
    while (Date.now() < deadline) {
      const jobs = await get(`${root}/attempts/${process.env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`);
      const missing = [];
      for (const [artifact, jobName] of required) {
        const assets = await get(`${root}/artifacts?name=${encodeURIComponent(artifact)}`);
        if (assets.artifacts.some(a => !a.expired)) continue;
        const job = jobs.jobs.find(j => j.name.endsWith(jobName));
        if (job?.conclusion) throw new Error(`${artifact} absent after ${jobName}: ${job.conclusion}`);
        missing.push(artifact);
      }
      if (missing.length === 0) process.exit(0);
      console.log(`Waiting for ${missing.join(", ")}`);
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    throw new Error("SSH runtime archive producers did not upload within 35 minutes");
    NODE

- name: Download SSH runtime archives
  uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8
  with:
    pattern: cli-*
    merge-multiple: true
    path: ssh-runtime-archives
```

Exact packaging invocation hunk (after the relocation):

```diff
@@
             --build-version "${{ inputs.version }}"
             --skip-build
+            --ssh-runtime-archive-dir "$GITHUB_WORKSPACE/ssh-runtime-archives"
+            --require-all-ssh-runtimes
             --verbose
```

The transformation is a relocation sketch; it preserves complete existing blocks rather than inventing their environment. Scope is the disabled workflow file only, not workflow enablement or publishing. Its graph tests cannot establish Apple/Windows signing or real artifact availability. The timeout grows because each packaging job now waits for three producers; every producer must upload before its own wait. Failed producer errors should cite the absent artifact and producer job. API errors fail promptly; retry policy can be added only with explicit bounded handling and tests.

The exact unified diff for that relocation follows (use either this or the transformation, never both):

### MODIFY `.github/workflows/release-desktop.yml`

```diff
--- a/.github/workflows/release-desktop.yml
+++ b/.github/workflows/release-desktop.yml
@@ -103,7 +103,7 @@
     runs-on: ${{ inputs.runner }}
     # Windows waits for the Linux CLI archive inside its own budget (see
     # "Wait for Linux CLI archive"), so it gets that wait on top of the usual 30.
-    timeout-minutes: ${{ inputs.platform == 'win' && 70 || 30 }}
+    timeout-minutes: 70
     env:
       T3CODE_CLERK_PUBLISHABLE_KEY: ${{ inputs.clerk_publishable_key }}
       T3CODE_CLERK_JWT_TEMPLATE: ${{ inputs.clerk_jwt_template }}
@@ -308,6 +308,154 @@
             Where-Object { $_ -and (Test-Path $_) } |
             Select-Object -Unique
           "PSModulePath=$($modulePathEntries -join ';')" >> $env:GITHUB_ENV
+
+      # The single-executable is built with a Node that supports --build-sea
+      # (25.7+); the repo itself stays on the engines.node version. It always
+      # injects into the runner's own Node: tsdown's cross-target download path
+      # runs `tar` on a drive-letter path on Windows, which GNU tar reads as a
+      # remote host, and a cross-built macOS binary cannot be smoke-tested.
+      - name: Build CLI single-executable
+        if: inputs.cli_archive
+        shell: bash
+        env:
+          # The exact version, not a major: vp downloads it from nodejs.org/dist on
+          # the runner, and only exact versions have a dist directory. Keep in
+          # step with SEA_NODE_VERSION in apps/server/vite.config.ts.
+          VP_NODE_VERSION: "26.8.2"
+        run: node apps/server/scripts/cli.ts build-exe --verbose
+
+      - name: Import macOS signing certificate for the CLI archive
+        if: inputs.cli_archive && inputs.platform == 'mac'
+        shell: bash
+        env:
+          CSC_LINK: ${{ secrets.CSC_LINK }}
+          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
+        run: |
+          set -euo pipefail
+          if [[ -z "$CSC_LINK" || -z "$CSC_KEY_PASSWORD" ]]; then
+            echo "macOS CLI signing disabled (missing CSC_LINK); the archive is signed ad hoc."
+            exit 0
+          fi
+          keychain="$RUNNER_TEMP/t3-cli-signing.keychain-db"
+          keychain_password="$(openssl rand -hex 16)"
+          cert_path="$RUNNER_TEMP/t3-cli-signing.p12"
+          printf '%s' "$CSC_LINK" | base64 --decode > "$cert_path"
+          security create-keychain -p "$keychain_password" "$keychain"
+          security set-keychain-settings -lut 21600 "$keychain"
+          security unlock-keychain -p "$keychain_password" "$keychain"
+          security import "$cert_path" -k "$keychain" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign
+          security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
+          security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
+          identity="$(security find-identity -v -p codesigning "$keychain" | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n 1)"
+          if [[ -z "$identity" ]]; then
+            echo "No Developer ID Application identity found in CSC_LINK." >&2
+            exit 1
+          fi
+          echo "::add-mask::$keychain_password"
+          echo "T3CODE_CLI_MAC_SIGN_IDENTITY=$identity" >> "$GITHUB_ENV"
+          echo "macOS CLI signing enabled."
+
+      - name: Build resource monitor before CLI archive
+        if: inputs.cli_archive && steps.resource_monitor_cache.outputs.cache-hit != 'true'
+        shell: bash
+        run: cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target "${{ inputs.rust_target }}"
+
+      - name: Stage resource monitor for the CLI archive
+        if: inputs.cli_archive
+        shell: bash
+        run: |
+          set -euo pipefail
+          binary_name="t3-resource-monitor"
+          if [[ "${{ inputs.platform }}" == "win" ]]; then
+            binary_name="${binary_name}.exe"
+          fi
+          target_dir="$RUNNER_TEMP/cli-resource-monitor/${{ inputs.resource_key }}"
+          mkdir -p "$target_dir"
+          cp "native/resource-monitor/target/${{ inputs.rust_target }}/release/${binary_name}" "$target_dir/$binary_name"
+
+      - name: Build CLI archive
+        if: inputs.cli_archive
+        shell: bash
+        env:
+          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
+          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
+          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
+          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
+          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
+          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
+          AZURE_TRUSTED_SIGNING_ENDPOINT: ${{ secrets.AZURE_TRUSTED_SIGNING_ENDPOINT }}
+          AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: ${{ secrets.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME }}
+          AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: ${{ secrets.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME }}
+        run: |
+          set -euo pipefail
+          if [[ "${{ inputs.platform }}" == "mac" && -n "${APPLE_API_KEY:-}" ]]; then
+            key_path="$RUNNER_TEMP/AuthKey_cli_${APPLE_API_KEY_ID}.p8"
+            printf '%s' "$APPLE_API_KEY" > "$key_path"
+            export APPLE_API_KEY="$key_path"
+          fi
+          node scripts/build-cli-archive.ts \
+            --platform "${{ inputs.platform }}" \
+            --arch "${{ inputs.arch }}" \
+            --version "${{ inputs.version }}" \
+            --resource-monitor-dir "$RUNNER_TEMP/cli-resource-monitor" \
+            --output-dir release-cli
+
+      - name: Smoke-test CLI archive
+        if: inputs.cli_archive
+        shell: bash
+        run: node scripts/smoke-cli-archive.ts --archive release-cli/* --expect-version "${{ inputs.version }}"
+
+      - name: Upload CLI archive
+        if: inputs.cli_archive
+        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
+        with:
+          name: cli-${{ inputs.platform }}-${{ inputs.arch }}
+          path: release-cli/*
+          if-no-files-found: error
+
+      - name: Wait for SSH runtime archives
+        shell: bash
+        timeout-minutes: 40
+        env:
+          GH_TOKEN: ${{ github.token }}
+        run: |
+          node --input-type=module <<'NODE'
+          const required = new Map([
+            ["cli-mac-arm64", "Build macOS arm64"],
+            ["cli-linux-x64", "Build Linux x64"],
+            ["cli-linux-arm64", "Build Linux arm64"],
+          ]);
+          const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" };
+          const root = `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
+          const deadline = Date.now() + 35 * 60_000;
+          async function get(url) {
+            const response = await fetch(url, { headers });
+            if (!response.ok) throw new Error(`Actions API ${response.status}`);
+            return response.json();
+          }
+          while (Date.now() < deadline) {
+            const jobs = await get(`${root}/attempts/${process.env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`);
+            const missing = [];
+            for (const [artifact, jobName] of required) {
+              const assets = await get(`${root}/artifacts?name=${encodeURIComponent(artifact)}`);
+              if (assets.artifacts.some(a => !a.expired)) continue;
+              const job = jobs.jobs.find(j => j.name.endsWith(jobName));
+              if (job?.conclusion) throw new Error(`${artifact} absent after ${jobName}: ${job.conclusion}`);
+              missing.push(artifact);
+            }
+            if (missing.length === 0) process.exit(0);
+            console.log(`Waiting for ${missing.join(", ")}`);
+            await new Promise(resolve => setTimeout(resolve, 10_000));
+          }
+          throw new Error("SSH runtime archive producers did not upload within 35 minutes");
+          NODE
+
+      - name: Download SSH runtime archives
+        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8
+        with:
+          pattern: cli-*
+          merge-multiple: true
+          path: ssh-runtime-archives

       # The WSL backend runs the Linux CLI archive inside the distro, so the
       # Windows desktop embeds the same-arch archive the release attaches.
@@ -398,6 +546,8 @@
             --arch "${{ inputs.arch }}"
             --build-version "${{ inputs.version }}"
             --skip-build
+            --ssh-runtime-archive-dir "$GITHUB_WORKSPACE/ssh-runtime-archives"
+            --require-all-ssh-runtimes
             --verbose
           )

@@ -455,105 +605,6 @@

           vp run dist:desktop:artifact "${args[@]}"

-      # The single-executable is built with a Node that supports --build-sea
-      # (25.7+); the repo itself stays on the engines.node version. It always
-      # injects into the runner's own Node: tsdown's cross-target download path
-      # runs `tar` on a drive-letter path on Windows, which GNU tar reads as a
-      # remote host, and a cross-built macOS binary cannot be smoke-tested.
-      - name: Build CLI single-executable
-        if: inputs.cli_archive
-        shell: bash
-        env:
-          # The exact version, not a major: vp downloads it from nodejs.org/dist on
-          # the runner, and only exact versions have a dist directory. Keep in
-          # step with SEA_NODE_VERSION in apps/server/vite.config.ts.
-          VP_NODE_VERSION: "26.8.2"
-        run: node apps/server/scripts/cli.ts build-exe --verbose
-
-      - name: Import macOS signing certificate for the CLI archive
-        if: inputs.cli_archive && inputs.platform == 'mac'
-        shell: bash
-        env:
-          CSC_LINK: ${{ secrets.CSC_LINK }}
-          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
-        run: |
-          set -euo pipefail
-          if [[ -z "$CSC_LINK" || -z "$CSC_KEY_PASSWORD" ]]; then
-            echo "macOS CLI signing disabled (missing CSC_LINK); the archive is signed ad hoc."
-            exit 0
-          fi
-          keychain="$RUNNER_TEMP/t3-cli-signing.keychain-db"
-          keychain_password="$(openssl rand -hex 16)"
-          cert_path="$RUNNER_TEMP/t3-cli-signing.p12"
-          printf '%s' "$CSC_LINK" | base64 --decode > "$cert_path"
-          security create-keychain -p "$keychain_password" "$keychain"
-          security set-keychain-settings -lut 21600 "$keychain"
-          security unlock-keychain -p "$keychain_password" "$keychain"
-          security import "$cert_path" -k "$keychain" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign
-          security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
-          security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
-          identity="$(security find-identity -v -p codesigning "$keychain" | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n 1)"
-          if [[ -z "$identity" ]]; then
-            echo "No Developer ID Application identity found in CSC_LINK." >&2
-            exit 1
-          fi
-          echo "::add-mask::$keychain_password"
-          echo "T3CODE_CLI_MAC_SIGN_IDENTITY=$identity" >> "$GITHUB_ENV"
-          echo "macOS CLI signing enabled."
-
-      - name: Stage resource monitor for the CLI archive
-        if: inputs.cli_archive
-        shell: bash
-        run: |
-          set -euo pipefail
-          binary_name="t3-resource-monitor"
-          if [[ "${{ inputs.platform }}" == "win" ]]; then
-            binary_name="${binary_name}.exe"
-          fi
-          target_dir="$RUNNER_TEMP/cli-resource-monitor/${{ inputs.resource_key }}"
-          mkdir -p "$target_dir"
-          cp "native/resource-monitor/target/${{ inputs.rust_target }}/release/${binary_name}" "$target_dir/$binary_name"
-
-      - name: Build CLI archive
-        if: inputs.cli_archive
-        shell: bash
-        env:
-          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
-          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
-          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
-          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
-          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
-          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
-          AZURE_TRUSTED_SIGNING_ENDPOINT: ${{ secrets.AZURE_TRUSTED_SIGNING_ENDPOINT }}
-          AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: ${{ secrets.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME }}
-          AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: ${{ secrets.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME }}
-        run: |
-          set -euo pipefail
-          if [[ "${{ inputs.platform }}" == "mac" && -n "${APPLE_API_KEY:-}" ]]; then
-            key_path="$RUNNER_TEMP/AuthKey_cli_${APPLE_API_KEY_ID}.p8"
-            printf '%s' "$APPLE_API_KEY" > "$key_path"
-            export APPLE_API_KEY="$key_path"
-          fi
-          node scripts/build-cli-archive.ts \
-            --platform "${{ inputs.platform }}" \
-            --arch "${{ inputs.arch }}" \
-            --version "${{ inputs.version }}" \
-            --resource-monitor-dir "$RUNNER_TEMP/cli-resource-monitor" \
-            --output-dir release-cli
-
-      - name: Smoke-test CLI archive
-        if: inputs.cli_archive
-        shell: bash
-        run: node scripts/smoke-cli-archive.ts --archive release-cli/* --expect-version "${{ inputs.version }}"
-
-      - name: Upload CLI archive
-        if: inputs.cli_archive
-        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
-        with:
-          name: cli-${{ inputs.platform }}-${{ inputs.arch }}
-          path: release-cli/*
-          if-no-files-found: error
-
       - name: Collect release assets
         shell: bash
         run: |
```

## 7. Tests to add, with real behavior oracles

No tests are run by this leaf. Add the supplied hunks and the explicitly enumerated follow-ups; assertions against the generated script string alone are insufficient for acquisition/install behavior. Existing tests already cover local cache, mirrors and retained-runner failures; preserve them.

### SSH: isolated HOME, real probe/upload shell

Append this block to `packages/ssh/src/tunnel.test.ts`. It uses existing `ARCHIVE`, `uploadTarget`, `platform`, `arch`, `encoder` and `makeSuccessfulProcess`. The insertion anchor is the current EOF after item 2's `install before runner switch` describe (source lines 2525–2532). Only SSH transport and gh API responses are substituted; `sh`, `tar`, digest checking and runtime promotion execute for real in a scoped directory. No ssh binary or daemon is launched. POSIX cases skip on Windows; never use the real HOME.

### MODIFY `packages/ssh/src/tunnel.test.ts`

```diff
--- a/packages/ssh/src/tunnel.test.ts
+++ b/packages/ssh/src/tunnel.test.ts
@@ -2525,8 +2525,141 @@
           assert.deepEqual(yield* f.snapshot, before);
           assert.isTrue(yield* f.oldProcess!.isRunning);
           assert.isFalse((yield* f.events).some((event) => event.type === "stop"));
           yield* f.cleanCandidates;
         }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
     );
   },
 );
+
+describe("bundled runtime acquisition", () => {
+  it.live.each(["bundle", "cache", "gh", "ready", "retained", "corrupt", "missing-sidecar", "wrong-executable", "bundle-only"] as const)(
+    "%s installs or preserves the selected runtime without writing bundle bytes",
+    (mode) => Effect.gen(function* () {
+      if (HostProcess.Platform.defaultValue() === "win32") return;
+      const fs = yield* FileSystem.FileSystem;
+      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
+      const crypto = yield* Crypto.Crypto;
+      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-bundle-behavior-" });
+      const home = `${root}/remote-home`;
+      const bundle = `${root}/packaged resources/ssh-runtime/archives`;
+      const cache = `${root}/cache`;
+      const asset = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz`;
+      const executable = (version: string, origin: string) => `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf 'goat v${version}\\n'\nelif [ "$1" = "auth" ] && [ "$2" = "pairing" ]; then\n  printf '{"credential":"${origin}-pairing"}\\n'\nelse\n  exit 64\nfi\n`;
+      const makeArchive = (directory: string, origin: string) => Effect.gen(function* () {
+        const stem = asset.slice(0, -7);
+        const content = `${root}/${origin}-content/${stem}`;
+        yield* fs.makeDirectory(content, { recursive: true });
+        yield* fs.makeDirectory(directory, { recursive: true });
+        const executableVersion = mode === "wrong-executable" && origin === "bundle" ? "1.2.2" : ARCHIVE.archiveVersion;
+        yield* fs.writeFileString(`${content}/goat`, executable(executableVersion, origin));
+        yield* fs.chmod(`${content}/goat`, 0o700);
+        yield* fs.writeFileString(`${content}/origin`, origin);
+        const tar = yield* realSpawner.spawn(ChildProcess.make("tar", ["-czf", `${directory}/${asset}`, "-C", `${root}/${origin}-content`, stem]));
+        assert.equal(Number(yield* tar.exitCode), 0);
+        const bytes = yield* fs.readFile(`${directory}/${asset}`);
+        const hash = Hex.encode(yield* crypto.digest("SHA-256", bytes));
+        yield* fs.writeFileString(`${directory}/${asset}.sha256`, `${hash}  ${asset}\n`);
+        return { bytes, hash };
+      });
+      yield* fs.makeDirectory(home, { recursive: true });
+      const fromBundle = yield* makeArchive(bundle, "bundle");
+      const fromCache = yield* makeArchive(cache, "cache");
+      const fromGh = yield* makeArchive(`${root}/gh-source`, "gh");
+      if (mode === "corrupt" || mode === "ready" || mode === "retained") yield* fs.writeFileString(`${bundle}/${asset}.sha256`, `${"0".repeat(64)}  ${asset}\n`);
+      if (mode === "missing-sidecar") yield* fs.remove(`${bundle}/${asset}.sha256`);
+      if (mode === "cache" || mode === "gh") yield* fs.remove(`${bundle}/${asset}`);
+      if (mode === "gh") yield* fs.remove(`${cache}/${asset}`);
+      const bundleBefore = yield* fs.readDirectory(bundle);
+      const bundleArchiveBefore = yield* fs.exists(`${bundle}/${asset}`) ? yield* fs.readFile(`${bundle}/${asset}`) : null;
+      const stateKey = yield* remoteStateKey(uploadTarget);
+      const retainedVersion = "1.2.2-preview.20260910.1";
+      const installedVersion = mode === "retained" ? retainedVersion : ARCHIVE.archiveVersion;
+      const runtime = `${home}/.goat/runtime/goat/versions/${installedVersion}`;
+      if (mode === "ready" || mode === "retained") {
+        yield* fs.makeDirectory(runtime, { recursive: true });
+        yield* fs.writeFileString(`${runtime}/goat`, executable(installedVersion, mode));
+        yield* fs.chmod(`${runtime}/goat`, 0o700);
+        yield* fs.writeFileString(`${runtime}/.install-complete`, installedVersion);
+        yield* fs.writeFileString(`${runtime}/origin`, mode);
+        if (mode === "retained") {
+          const state = `${home}/.goat/ssh-launch/${stateKey}`;
+          yield* fs.makeDirectory(state, { recursive: true });
+          yield* fs.writeFileString(`${state}/run-t3.sh`, SshTunnel.buildRemoteT3RunnerScript({ archiveVersion: retainedVersion }));
+          yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
+        }
+      }
+      const mutations: string[] = [];
+      const guard = (file: string) => { if (file === bundle || file.startsWith(bundle + "/")) mutations.push(file); };
+      const checkedFs = FileSystem.FileSystem.of({
+        ...fs,
+        writeFile: (file, bytes, options) => { guard(file); return fs.writeFile(file, bytes, options); },
+        writeFileString: (file, text, options) => { guard(file); return fs.writeFileString(file, text, options); },
+        makeDirectory: (file, options) => { guard(file); return fs.makeDirectory(file, options); },
+        remove: (file, options) => { guard(file); return fs.remove(file, options); },
+        rename: (from, to) => { guard(from); guard(to); return fs.rename(from, to); },
+        chmod: (file, mode) => { guard(file); return fs.chmod(file, mode); },
+      });
+      let downloads = 0;
+      const spawner = ChildProcessSpawner.make((command) => Effect.gen(function* () {
+        assert.equal(command._tag, "StandardCommand");
+        if (command._tag !== "StandardCommand") return makeSuccessfulProcess("");
+        if (command.command === "gh") {
+          downloads++;
+          const destination = command.args[command.args.indexOf("--dir") + 1]!;
+          assert.isFalse(destination.startsWith(bundle));
+          yield* fs.writeFile(`${destination}/${asset}`, fromGh.bytes);
+          yield* fs.writeFileString(`${destination}/SHA256SUMS`, `${fromGh.hash}  ${asset}\n`);
+          return makeSuccessfulProcess("");
+        }
+        const index = command.args.indexOf("sh");
+        assert.isAtLeast(index, 0);
+        const remoteArgs = command.args.slice(index);
+        return yield* realSpawner.spawn(ChildProcess.make("sh",
+          command.args.includes("-c") ? ["-c", remoteArgs.join(" ")] : ["-s"], {
+            env: { HOME: home, PATH: process.env.PATH ?? "" }, extendEnv: false,
+            stdin: command.options.stdin,
+          }));
+      }));
+      const runner = {
+        ...ARCHIVE, bundledArchiveDirectory: bundle,
+        ...(mode === "bundle-only" ? {} : { archiveDirectory: cache }),
+        // Bundle must also win over an explicit unusable mirror.
+        ...(mode === "bundle" ? { releaseBaseUrl: "file:///unavailable" } : {}),
+        keepExistingRunner: mode === "retained",
+      };
+      const result = yield* Effect.result(SshTunnel.prepareRemoteRuntime(uploadTarget, {}, runner, stateKey).pipe(
+        Effect.provideService(FileSystem.FileSystem, checkedFs),
+        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
+      ));
+      const failure = mode === "corrupt" || mode === "missing-sidecar" || mode === "wrong-executable";
+      assert.equal(Result.isFailure(result), failure);
+      if (failure) {
+        assert.isFalse(yield* fs.exists(`${runtime}/.install-complete`));
+        assert.isFalse(yield* fs.exists(`${home}/.goat/ssh-launch/${stateKey}/run-t3.sh`));
+      } else {
+        const expected = mode === "bundle-only" ? "bundle" : mode;
+        assert.equal(yield* fs.readFileString(`${runtime}/origin`), expected);
+        assert.equal((yield* fs.readFileString(`${runtime}/.install-complete`)).trim(), installedVersion);
+        const runnerFile = `${home}/.goat/ssh-launch/${stateKey}/run-t3.sh`;
+        const retainedBefore = mode === "retained" ? yield* fs.readFileString(runnerFile) : null;
+        if (mode !== "retained") assert.isFalse(yield* fs.exists(runnerFile));
+        // Public pairing runs prepare again, then verifies/publishes its candidate.
+        const pairing = yield* SshTunnel.issueRemotePairingToken(uploadTarget, {}, runner).pipe(
+          Effect.provideService(FileSystem.FileSystem, checkedFs),
+          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
+        );
+        assert.equal(pairing.credential, `${expected}-pairing`);
+        assert.isTrue(yield* fs.exists(runnerFile));
+        if (retainedBefore !== null) assert.equal(yield* fs.readFileString(runnerFile), retainedBefore);
+        assert.deepEqual((yield* fs.readDirectory(`${home}/.goat/ssh-launch/${stateKey}`)).filter((name) => name.startsWith("run-t3.next.")), []);
+      }
+      assert.equal(downloads, mode === "gh" ? 1 : 0);
+      assert.deepEqual(mutations, []);
+      assert.deepEqual(yield* fs.readDirectory(bundle), bundleBefore);
+      if (bundleArchiveBefore !== null) assert.deepEqual(yield* fs.readFile(`${bundle}/${asset}`), bundleArchiveBefore);
+      if (mode !== "gh") assert.deepEqual(yield* fs.readFile(`${cache}/${asset}`), fromCache.bytes);
+      // Distinct tar origins prove which executable tree actually got installed.
+      assert.notDeepEqual(fromBundle.bytes, fromCache.bytes);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+});
```

Add these focused follow-ups to the same describe, using the same shell harness rather than generated-string snapshots:

- Wrong bundle version/platform (only the other asset exists) → cache wins; corrupt matching bundle → fails before upload, leaves prior runner, managed ownership files and running process unchanged (reuse wp1's spawned-process harness and await its exit/event signals; no sleeps).
- Remote ready and retained ready + deliberately invalid bundle sidecar → local invalidity is never read; same runner bytes/process and origin survive. The supplied ready/retained cases already set the bundle sidecar to zero-digest; preserve that bypass oracle. Their remote executables now report their selected exact version so the public pairing/candidate path can execute.
- Missing bundle and empty cache config → actionable failure; alias-identical bundle/cache config with missing archive → no gh and no bundle writes. Blank bundle config preserves existing cache/gh/mirror behavior.
- The supplied test covers bundle → upload → exact-version installer → public pairing → candidate verification/publication (and retained runner byte preservation). Extend the same fixture to `launchOrReuseRemoteServer` and `issueRemoteMcpClientSession`; installed marker/version, pairing token and MCP response must come from the selected uploaded archive; gh stays unused. Reuse item 2's spawned-server/event fixture for launch/MCP. Add a canonical, matching-hash bundle whose executable reports the wrong version: it must fail before runtime promotion (included above). Separately make the installed executable fail/report a wrong version only at the candidate invocation after upload, then assert unchanged old runner, pid/port/managed files and old process, no stop/start event and no `run-t3.next.*` leftovers. A successful upload alone does not prove the runner switch boundary.
- Cache write/download/upload failure → bundle unchanged and old remote runner/process preserved; transport failure at upload remains retryable through the existing manager's authentication path.

`runtimeArchive.test.ts`: add cases for `readLocalRuntimeArchive(dir, version, key, true)` returning null when asset absent, rejecting missing/malformed/noncanonical/wrong digest sidecar, accepting a canonical sidecar and exact bytes, while legacy user cache without sidecar remains accepted. Use files and returned digest/errors, not mock call-order assertions.

### Desktop/server input chain

Add config-resolution tests alongside existing descriptions:

- `desktopSshCliRunner.test.ts`: archiveOptions with bundle path containing spaces; packaged runner passes it unchanged; dev node override drops archive options; unpackaged normal runner receives no bundle from main's creator. Keep nightly version assertion.
- `DesktopBackendConfiguration.test.ts`: `resolvePrimary` with packaged resourcesPath containing spaces exports its exact bundle path and preserves unrelated child env; unpackaged primary clears a stale ambient bundle env. Test real generated start configuration, not private callback wiring.
- Same backend test, WSL: mock `windowsToWslPath` result `/mnt/c/Program Files/GOAT/resources/ssh-runtime/archives`, assert the Linux child receives it plus WSLENV contains exactly one bare `T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR`; failed translation has no Windows value or residual WSLENV entry; unrelated WSLENV entries survive; selected distro matches runningDistro. Exercise inherited `T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR/p`, bare duplicates, `/l`, `/u`, `/w` and combined flags (concrete regression hunk below). Also check cleanup when unpackaged.
- `SshRemoteDispatch.test.ts`: fromEnvRecord with padded bundle path, custom cache path and mirror yields trimmed bundle, independently chosen cache, unchanged keepExistingRunner. Missing/blank bundle omits the field. Use preserveEmptyStrings for blank cases. Cold acquisition correctness is covered by the SSH real-shell tests rather than duplicating them with fake wire strings.

### Packaging behavior

Append meaningful filesystem/tar cases to existing build-desktop-artifact.test.ts, extending its existing `makeLinuxCliArchiveFixture` to accept the required resource-monitor member via extraMembers:

- Native host-only valid tar → stage emits exactly one archive plus canonical checksum; source directory manifest/bytes/sidecars unchanged; validateSshRuntimeArchives on output returns same hash.
- Three target fixtures → strict stage succeeds; missing each target, missing source directory, wrong version, tar with wrong top-level stem, missing goat/client/monitor/node-pty, loose bin.mjs, corrupt tar, oversize and bad existing sidecar all fail before destination creation.
- Missing source sidecar → successful canonicalization; malformed existing sidecar → failure; packaged matching-hash but noncanonical sidecar → failure. Desktop bundle version different from the embedded server package version → reject before staging (including an explicit `--version` override). Existing user input without a sidecar remains allowed only before staging.
- Simulate builder extraResources copy into temp `mac-arm64/GOAT.app/Contents/Resources`, `linux-unpacked/resources`, `win-unpacked/resources`; verify `validatePackagedSshRuntimeArchives` succeeds. Drop archive/sidecar or mutate copied bytes → failure even when stage is intact.
- `resolveBuildOptions` with CI=true + explicit flag false still requires all; local flag true requires all; local supplied host-only bundle accepts; local omission preserves existing packaging without extraResource paths. The resource-copy test reads the build config's file sets and actually copies matching bytes (or uses electron-builder's FileSet copy utility); asserting array membership alone is not the packaging oracle.

### New development command test file

The NEW script's `repoRoot` input allows a temporary fake source/build tree. `scripts/dev-runtime-archive.test.ts` must execute actual child processes in an isolated HOME, with executable vp/cargo stand-ins on a temporary PATH; do not execute real Rust/SEA builds from tests. Exported `buildDevRuntimeArchive` returns a Promise; wrap it with Effect.tryPromise under it.live rather than manually creating an Effect runtime in test code.

Stand-in vp answers the Node probe, then on build-cli-archive writes a real tar containing goat, client/index.html, node-pty and resource-monitor for the host into --output-dir. Stand-in cargo writes a fixture monitor under the fake repo's native/resource-monitor/target/release. Record a child log only as supplemental evidence; the oracle is the produced cache tar, canonical digest, executable --version, and preserved old archive on failure.

Required cases: actual Node probe <25.7 (abort before build/cache publication), malformed explicit selector, Node process already capable, VP_NODE_VERSION choice honored, probe disagreement despite valid selector, web build failure, SEA failure, cargo failure, packaging failure, archive validation failure, successful replacement, final rename failure with old sidecar restored, concurrent publication lock refusal, and scoped staging/lock cleanup. Isolated `.git` worktree-pointer file + ambient T3CODE_HOME tests prove home precedence without invoking git. Explicit --home-dir wins; no test accesses ~/.t3/userdata or real build outputs.

### Workflow tests (data + executable embedded wait)

`scripts/release-desktop-runtime.test.ts`: parse workflow YAML through the existing Effect YAML decoder; assert dependency order by named steps and that every `inputs.cli_archive` producer uploads before Wait for SSH runtime archives; download occurs before packaging; packaging includes directory + strict flag; cargo precedes Stage resource monitor. These are configuration-contract tests, not implementation-mirroring component tests.

Extract the embedded wait Node program and execute it in a child with fake fetch/clock/timers in a VM: all three artifacts → zero exit; producer concluded without artifact → error naming it; expired artifact counts as absent; missing producer reaches deadline → bounded error; 401/API failure → clear failure; no GH_TOKEN contents logged. Test matrix artifact names against existing release.yml invocations, without changing or enabling that workflow.

The following complete test hunks provide the core executable additions; the matrix above remains the acceptance checklist for failure/path variations during implementation.

### MODIFY `packages/ssh/src/runtimeArchive.test.ts`

```diff
--- a/packages/ssh/src/runtimeArchive.test.ts
+++ b/packages/ssh/src/runtimeArchive.test.ts
@@ -67,3 +67,23 @@
       }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
   );
 });
+
+describe("read-only bundled archive checksum", () => {
+  it.effect.each(["valid", "missing", "malformed", "noncanonical", "mismatch"] as const)(
+    "requires a canonical sidecar (%s)",
+    (mode) => Effect.gen(function* () {
+      const fs = yield* FileSystem.FileSystem;
+      const root = yield* fs.makeTempDirectoryScoped();
+      const name = "goat-1.2.3-linux-x64.tar.gz";
+      const bytes = new Uint8Array([0, 128, 255]);
+      yield* fs.writeFile(`${root}/${name}`, bytes);
+      const valid = "5240672d7b51756b829ad0ef8d9468b7a078afa2f410484fd3892dab47becb72";
+      if (mode !== "missing") yield* fs.writeFileString(`${root}/${name}.sha256`,
+        mode === "valid" ? `${valid}  ${name}\n` : mode === "noncanonical" ? `${valid} *${name}\n` : mode === "malformed" ? "bad" : `${"0".repeat(64)}  ${name}\n`);
+      const result = yield* Effect.result(readLocalRuntimeArchive(root, "1.2.3", "linux-x64", true));
+      assert.equal(Result.isFailure(result), mode !== "valid");
+      if (Result.isSuccess(result)) assert.deepEqual(result.success?.bytes, bytes);
+      assert.deepEqual(yield* fs.readFile(`${root}/${name}`), bytes);
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
+});
```

### MODIFY `apps/server/src/sshRemote/SshRemoteDispatch.test.ts`

```diff
--- a/apps/server/src/sshRemote/SshRemoteDispatch.test.ts
+++ b/apps/server/src/sshRemote/SshRemoteDispatch.test.ts
@@ -340,3 +340,26 @@
       }),
   );
 });
+
+describe("SSH dispatch packaged runtime", () => {
+  it.effect("resolves bundle separately from writable user cache", () => Effect.gen(function* () {
+    const runner = yield* resolveSshCliRunner("/fixture/home").pipe(Effect.provideService(
+      ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({
+        T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR: "  /Applications/GOAT.app/Contents/Resources/ssh-runtime/archives  ",
+        T3CODE_SSH_RUNTIME_ARCHIVE_DIR: "/fixture/user-cache",
+      }),
+    ));
+    expect(runner.bundledArchiveDirectory).toBe("/Applications/GOAT.app/Contents/Resources/ssh-runtime/archives");
+    expect(runner.archiveDirectory).toBe("/fixture/user-cache");
+    expect(runner.keepExistingRunner).toBe(true);
+  }));
+  it.effect.each([undefined, "", "  "])("omits empty bundle %s", (value) => Effect.gen(function* () {
+    const runner = yield* resolveSshCliRunner("/fixture/home").pipe(Effect.provideService(
+      ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({
+        T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR: value,
+      }, { preserveEmptyStrings: true }),
+    ));
+    expect("bundledArchiveDirectory" in runner).toBe(false);
+    expect(runner.archiveDirectory).toBe("/fixture/home/runtime/archives");
+  }));
+});
```

### NEW `scripts/dev-runtime-archive.test.ts`

```diff
--- /dev/null
+++ b/scripts/dev-runtime-archive.test.ts
@@ -0,0 +1,100 @@
+// @effect-diagnostics nodeBuiltinImport:off - This test executes isolated build-tool stand-ins and inspects the published tar.
+import * as NodeFSP from "node:fs/promises";
+import * as NodeOS from "node:os";
+import * as NodePath from "node:path";
+import * as NodeChildProcess from "node:child_process";
+import * as NodeCrypto from "node:crypto";
+import { assert, describe, it } from "@effect/vitest";
+import * as NodeServices from "@effect/platform-node/NodeServices";
+import * as Effect from "effect/Effect";
+import * as FileSystem from "effect/FileSystem";
+import { cliArchiveFileName, cliArchivePlatformKey } from "@t3tools/shared/cliRelease";
+import { buildDevRuntimeArchive, resolveRuntimeArchiveHome } from "./dev-runtime-archive.ts";
+import serverPackageJson from "../apps/server/package.json" with { type: "json" };
+
+const standIn = `#!${process.execPath}
+const fs = require('node:fs');
+const path = require('node:path');
+const cp = require('node:child_process');
+const args = process.argv.slice(2);
+const tool = path.basename(process.argv[1]);
+fs.appendFileSync(process.env.TOOL_LOG, JSON.stringify({tool,args,node:process.env.VP_NODE_VERSION})+'\n');
+if (args.join(' ') === 'exec node -p process.version') {
+  console.log(process.env.PROBE_VERSION || 'v'+process.env.VP_NODE_VERSION); process.exit(0);
+}
+if (process.env.FAIL_STEP && (tool === process.env.FAIL_STEP || args.includes(process.env.FAIL_STEP))) process.exit(43);
+if (tool === 'cargo') {
+  const file=path.join(process.cwd(),'native/resource-monitor/target/release/t3-resource-monitor');
+  fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,'monitor');
+}
+if (args.includes('scripts/build-cli-archive.ts')) {
+  const value = flag => args[args.indexOf(flag)+1];
+  const platform=value('--platform')==='mac'?'darwin':value('--platform');
+  const stem='goat-'+value('--version')+'-'+platform+'-'+value('--arch');
+  const output=value('--output-dir'); const content=path.join(output,'fixture',stem);
+  const entries=['client/index.html','node_modules/node-pty/build/Release/pty.node',
+    'resource-monitor/'+platform+'-'+value('--arch')+'/t3-resource-monitor'];
+  for (const entry of entries) { const file=path.join(content,entry); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,'fixture'); }
+  fs.writeFileSync(path.join(content,'goat'),'#!/bin/sh\nprintf \'goat v'+value('--version')+'\\n\'\n',{mode:0o755});
+  cp.execFileSync('tar',['-czf',path.join(output,stem+'.tar.gz'),'-C',path.dirname(content),stem]);
+}
+`;
+
+describe("development runtime archive publication", () => {
+  it.live.each(["success", "build", "build-exe", "cargo", "scripts/build-cli-archive.ts", "old-node"] as const)(
+    "%s preserves cache or publishes a verified executable tree",
+    (mode) => Effect.tryPromise(async () => {
+      if (process.platform === "win32") return;
+      const key = cliArchivePlatformKey(process.platform, process.arch);
+      if (key === undefined) return;
+      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-dev-archive-"));
+      try {
+        const fakeRepo = NodePath.join(root, "repo");
+        const tools = NodePath.join(root, "tools");
+        const home = NodePath.join(root, "home with spaces");
+        await NodeFSP.mkdir(fakeRepo, { recursive: true });
+        await NodeFSP.mkdir(tools, { recursive: true });
+        for (const name of ["vp", "cargo"]) await NodeFSP.writeFile(NodePath.join(tools, name), standIn, { mode: 0o755 });
+        const archives = NodePath.join(home, "runtime", "archives");
+        await NodeFSP.mkdir(archives, { recursive: true });
+        const name = cliArchiveFileName(serverPackageJson.version, key);
+        const old = Buffer.from("previous archive bytes");
+        await NodeFSP.writeFile(NodePath.join(archives, name), old);
+        const oldSidecar = 'previous checksum';
+        await NodeFSP.writeFile(NodePath.join(archives, name+'.sha256'), oldSidecar);
+        let failure: unknown;
+        try {
+          await buildDevRuntimeArchive({ homeDir: home, repoRoot: fakeRepo, nodeVersion: "26.8.2", env: {
+            ...process.env, HOME: home, PATH: tools+NodePath.delimiter+(process.env.PATH ?? ""),
+            TOOL_LOG: NodePath.join(root, "tools.jsonl"),
+            FAIL_STEP: mode === "success" || mode === "old-node" ? "" : mode,
+            PROBE_VERSION: mode === "old-node" ? "v24.13.1" : "v26.8.2",
+          } });
+        } catch (cause) { failure = cause; }
+        if (mode !== "success") {
+          assert.isDefined(failure);
+          assert.deepEqual(await NodeFSP.readFile(NodePath.join(archives, name)), old);
+          assert.equal(await NodeFSP.readFile(NodePath.join(archives, name+'.sha256'), 'utf8'), oldSidecar);
+        } else {
+          assert.isUndefined(failure);
+          const bytes = await NodeFSP.readFile(NodePath.join(archives, name));
+          const hash = NodeCrypto.createHash('sha256').update(bytes).digest('hex');
+          assert.equal(await NodeFSP.readFile(NodePath.join(archives, name+'.sha256'), 'utf8'), hash+'  '+name+'\n');
+          const extracted=NodePath.join(root,'extracted'); await NodeFSP.mkdir(extracted);
+          NodeChildProcess.execFileSync('tar',['-xzf',NodePath.join(archives,name),'-C',extracted]);
+          const binary=NodePath.join(extracted,name.slice(0,-7),'goat');
+          assert.equal(NodeChildProcess.execFileSync(binary,['--version'],{encoding:'utf8'}).trim(),'goat v'+serverPackageJson.version);
+        }
+        assert.deepEqual((await NodeFSP.readdir(archives)).filter(entry=>entry.startsWith('.goat-dev-')), []);
+        assert.equal((await NodeFSP.readdir(home)).includes('userdata'), false);
+      } finally { await NodeFSP.rm(root,{recursive:true,force:true}); }
+    }),
+  );
+  it.effect("worktree home outranks ambient home; explicit home outranks both", () => Effect.gen(function* () {
+    const fs = yield* FileSystem.FileSystem;
+    const root = yield* fs.makeTempDirectoryScoped();
+    yield* fs.writeFileString(root+'/.git', 'gitdir: /example/.git/worktrees/fixture\n');
+    assert.equal(yield* resolveRuntimeArchiveHome({ cwd: root, ambientHome: '/ambient' }), root+'/.t3');
+    assert.equal(yield* resolveRuntimeArchiveHome({ cwd: root, homeDir: root+'/explicit', ambientHome: '/ambient' }), root+'/explicit');
+  }).pipe(Effect.provide(NodeServices.layer),Effect.scoped)));
+});
```

### NEW `scripts/release-desktop-runtime.test.ts`

```diff
--- /dev/null
+++ b/scripts/release-desktop-runtime.test.ts
@@ -0,0 +1,56 @@
+// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow as configuration and runs its bounded wait program in an isolated VM.
+import * as NodeFSP from "node:fs/promises";
+import * as NodeVM from "node:vm";
+import { assert, describe, it } from "@effect/vitest";
+import * as Effect from "effect/Effect";
+import * as Schema from "effect/Schema";
+import { fromYaml } from "@t3tools/shared/schemaYaml";
+
+const decode = Schema.decodeUnknownEffect(fromYaml(Schema.Struct({
+  jobs: Schema.Struct({ build: Schema.Struct({ steps: Schema.Array(Schema.Struct({
+    name: Schema.optionalKey(Schema.String), run: Schema.optionalKey(Schema.String),
+    with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
+  })) }) }),
+})));
+
+describe("desktop release runtime supply", () => {
+  it.effect("uploads producer archives before waiting and packages the complete bundle", () => Effect.gen(function* () {
+    const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(new URL('../.github/workflows/release-desktop.yml', import.meta.url),'utf8'));
+    const workflow = yield* decode(raw);
+    const steps = workflow.jobs.build.steps;
+    const index = (name: string) => { const i=steps.findIndex(step=>step.name===name); assert.isAtLeast(i,0,name); return i; };
+    assert.isBelow(index('Build resource monitor before CLI archive'),index('Stage resource monitor for the CLI archive'));
+    assert.isBelow(index('Upload CLI archive'),index('Wait for SSH runtime archives'));
+    assert.isBelow(index('Wait for SSH runtime archives'),index('Download SSH runtime archives'));
+    assert.isBelow(index('Download SSH runtime archives'),index('Build desktop artifact'));
+    const build=steps[index('Build desktop artifact')]!.run!;
+    assert.include(build,'--ssh-runtime-archive-dir');
+    assert.include(build,'--require-all-ssh-runtimes');
+  }));
+  it.live.each(['ready','failed','expired','missing','api-error'] as const)(
+    'bounded artifact wait: %s', (mode) => Effect.tryPromise(async () => {
+      const raw=await NodeFSP.readFile(new URL('../.github/workflows/release-desktop.yml',import.meta.url),'utf8');
+      const run=raw.split('      - name: Wait for SSH runtime archives')[1]!.split('      - name: Download SSH runtime archives')[0]!;
+      const code=run.split("<<'NODE'\n")[1]!.split('          NODE')[0]!.split('\n').map(line=>line.slice(10)).join('\n');
+      let now=0; let exited=false;
+      const logs:string[]=[];
+      const context={
+        process:{env:{GH_TOKEN:'sentinel-secret',GITHUB_API_URL:'https://api.invalid',GITHUB_REPOSITORY:'goat-si/goat',GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1'},
+          exit:()=>{exited=true;throw new Error('fixture-exit-0');}},
+        console:{log:(line:string)=>logs.push(line)},
+        Date:{now:()=>now},setTimeout:(callback:()=>void)=>{now+=36*60_000;callback();},
+        fetch:async (url:string)=>({ok:mode!=='api-error',status:401,json:async()=>url.includes('/jobs?')
+          ? {jobs:mode==='failed'?[{name:'Desktop / Build Linux arm64',conclusion:'failure'}]:[]}
+          : {artifacts:mode==='ready'?[{expired:false}]:mode==='expired'?[{expired:true}]:[]}}),
+      };
+      let failure:unknown;
+      try { await NodeVM.runInNewContext('(async()=>{'+code+'})()',context); } catch(cause){failure=cause;}
+      if(mode==='ready')assert.isTrue(exited);
+      else { assert.isFalse(exited); assert.isDefined(failure); }
+      assert.isFalse(logs.some(line=>line.includes('sentinel-secret')));
+      if(mode==='failed')assert.include(String(failure),'cli-linux-arm64');
+      if(mode==='expired'||mode==='missing')assert.include(String(failure),'35 minutes');
+      if(mode==='api-error')assert.include(String(failure),'401');
+    }),
+  );
+});
```

### MODIFY `apps/desktop/src/backend/DesktopBackendConfiguration.test.ts`

```diff
--- a/apps/desktop/src/backend/DesktopBackendConfiguration.test.ts
+++ b/apps/desktop/src/backend/DesktopBackendConfiguration.test.ts
@@ -246,6 +246,8 @@
         assert.equal(first.cwd, environment.backendCwd);
         assert.equal(first.captureOutput, true);
         assert.equal(first.env.ELECTRON_RUN_AS_NODE, "1");
+        assert.equal(first.env.T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR,
+          environment.path.join(environment.resourcesPath, "ssh-runtime", "archives"));
         assert.isUndefined(first.env.T3CODE_PORT);
         assert.isUndefined(first.env.T3CODE_MODE);
         assert.isUndefined(first.env.T3CODE_DESKTOP_LAN_HOST);
```

Add the following behavior regression immediately before the existing inherited-WSLENV secrets test. It exercises the public generated configuration through the packaged WSL harness; the first case explicitly inherits `T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR/p`. Parameterization also covers the remaining flags, duplicates and a failed bundle-path translation.

```diff
--- a/apps/desktop/src/backend/DesktopBackendConfiguration.test.ts
+++ b/apps/desktop/src/backend/DesktopBackendConfiguration.test.ts
@@ -1105,1 +1105,42 @@
+  it.effect.each(["/p", "/l", "/u", "/w", "/pluw", ""] as const)(
+    "resolveWsl replaces inherited bundle WSLENV flags with a bare name: %s",
+    (suffix) => Effect.gen(function* () {
+      const name = "T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR";
+      const translated = "/mnt/c/Program Files/GOAT/resources/ssh-runtime/archives";
+      const previousWslEnv = process.env.WSLENV;
+      const previousBundle = process.env[name];
+      try {
+        for (const translationSucceeds of [true, false]) {
+          process.env.WSLENV = `GOPATH/p:EMPTY::${name}${suffix}:${name}:${name}/u:KEEP/w`;
+          process.env[name] = "C:\\Program Files\\GOAT\\resources\\ssh-runtime\\archives";
+          yield* withPackagedWslHarness(
+            {
+              archiveHash: "a".repeat(64),
+              wsl: (context) => ({
+                windowsToWslPath: (_distro, windowsPath) =>
+                  windowsPath.endsWith("archives")
+                    ? (translationSucceeds ? Option.some(translated) : Option.none())
+                    : Option.some(context.mountedAppRoot),
+              }),
+            },
+            () => Effect.gen(function* () {
+              const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
+              const config = yield* configuration.resolveWsl({ port: 5050, distro: "Ubuntu" });
+              assert.equal(config.env[name], translationSucceeds ? translated : undefined);
+              const entries = (config.env.WSLENV ?? "").split(":");
+              assert.deepEqual(
+                entries.filter((entry) => entry.trim().split("/")[0] === name),
+                translationSucceeds ? [name] : [],
+              );
+              assert.equal(entries.slice(0, 4).join(":"), "GOPATH/p:EMPTY::KEEP/w");
+            }),
+          );
+        }
+      } finally {
+        restoreEnv("WSLENV", previousWslEnv);
+        restoreEnv(name, previousBundle);
+      }
+    }),
+  );
+
   it.effect("resolveWsl preserves existing WSLENV entries when forwarding backend secrets", () =>
```

### MODIFY `packages/ssh/src/tunnel.test.ts`

```diff
--- a/packages/ssh/src/tunnel.test.ts
+++ b/packages/ssh/src/tunnel.test.ts
@@ -187,6 +187,8 @@
         for (const input of [
           inputs[key],
           { ...inputs[key], archiveDirectory: "/fixture/archives" },
+          { ...inputs[key], bundledArchiveDirectory: "/fixture/bundle" },
+          { ...inputs[key], archiveDirectory: "/fixture/archives", bundledArchiveDirectory: "/fixture/bundle" },
         ]) {
           const actual = yield* nativeScripts(input);
           assert.equal(actual.runner, baseline[key].runner);
```

### MODIFY `apps/desktop/src/ssh/desktopSshCliRunner.test.ts`

```diff
--- a/apps/desktop/src/ssh/desktopSshCliRunner.test.ts
+++ b/apps/desktop/src/ssh/desktopSshCliRunner.test.ts
@@ -66,3 +66,13 @@
     );
   });
 });
+
+it("carries read-only packaged resources separately from the writable cache", () => {
+  const options = { ...archiveOptions, bundledArchiveDirectory: "/Applications/GOAT Nightly.app/Contents/Resources/ssh-runtime/archives" };
+  const runner = resolveDesktopSshCliRunner(environment({ appVersion: "1.2.3-nightly.1", isPackaged: true, isDevelopment: false }), options, server);
+  assert.equal(runner.bundledArchiveDirectory, options.bundledArchiveDirectory);
+  assert.equal(runner.archiveDirectory, archiveOptions.archiveDirectory);
+  assert.notEqual(runner.bundledArchiveDirectory, runner.archiveDirectory);
+  const dev = resolveDesktopSshCliRunner(environment({ appVersion: "44", isPackaged: false, isDevelopment: true, devRemoteEntry: "/fixture/cli.mjs" }), options, server);
+  assert.isUndefined(dev.bundledArchiveDirectory);
+});
```

### MODIFY `scripts/build-desktop-artifact.test.ts`

```diff
--- a/scripts/build-desktop-artifact.test.ts
+++ b/scripts/build-desktop-artifact.test.ts
@@ -68,6 +68,10 @@
   stageResourceMonitor,
   stageLinuxCaptureHelper,
   stageWslRuntimeArchive,
+  stageSshRuntimeArchives,
+  validateSshRuntimeArchives,
+  validatePackagedSshRuntimeArchives,
+  SSH_RUNTIME_PLATFORM_KEYS,
   bundlesWslRuntime,
   STAGE_INSTALL_ARGS,
   ancestorNodeModulesPaths,
@@ -2549,3 +2553,51 @@
     ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"),
   );
 });
+
+it.effect.each(["local", "complete", "missing", "bad-sidecar", "missing-monitor", "wrong-stem"] as const)(
+  "stages and validates exact SSH payload bytes: %s", (mode) => Effect.gen(function* () {
+    const fs = yield* FileSystem.FileSystem;
+    const path = yield* Path.Path;
+    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-bundle-packaging-" });
+    const source = path.join(root, "source");
+    const destination = path.join(root, "staged");
+    const version = "1.2.3";
+    yield* fs.makeDirectory(source, { recursive: true });
+    const keys = mode === "complete" ? SSH_RUNTIME_PLATFORM_KEYS : [SSH_RUNTIME_PLATFORM_KEYS[0]];
+    const before = new Map<string, Uint8Array>();
+    for (const key of keys) {
+      const stem = `goat-${version}-${key}`;
+      const fixture = yield* makeLinuxCliArchiveFixture({
+        root: path.join(root, key),
+        stem: mode === "wrong-stem" ? "goat-9.9.9-linux-x64" : stem,
+        extraMembers: mode === "missing-monitor" ? [] : [`${stem}/resource-monitor/${key}/t3-resource-monitor`],
+      });
+      const name = `${stem}.tar.gz`;
+      const bytes = yield* fs.readFile(fixture);
+      yield* fs.writeFile(path.join(source, name), bytes);
+      before.set(name, bytes);
+      if (mode === "bad-sidecar") yield* fs.writeFileString(path.join(source, name+'.sha256'), "bad");
+    }
+    const result = yield* Effect.exit(stageSshRuntimeArchives({
+      sourceDirectory: source, destinationDirectory: destination, version,
+      requireAll: mode === "complete" || mode === "missing",
+    }));
+    const success = mode === "complete" || mode === "local";
+    assert.equal(result._tag === "Success", success);
+    for (const [name, bytes] of before) assert.deepEqual(yield* fs.readFile(path.join(source, name)), bytes);
+    if (!success) { assert.isFalse(yield* fs.exists(destination)); return; }
+    const archives = yield* validateSshRuntimeArchives({ directory: destination, version, requireAll: mode === "complete", requireSidecars: true });
+    assert.equal(archives.length, keys.length);
+    for (const archive of archives) {
+      assert.deepEqual(archive.bytes, before.get(archive.fileName));
+      assert.equal(yield* fs.readFileString(path.join(destination,archive.fileName+'.sha256')), `${archive.sha256}  ${archive.fileName}\n`);
+    }
+    const dist = path.join(root, "dist");
+    const resources = path.join(dist, "mac-arm64", "GOAT.app", "Contents", "Resources", "ssh-runtime", "archives");
+    yield* fs.makeDirectory(path.dirname(resources), { recursive: true });
+    yield* fs.copy(destination, resources);
+    yield* validatePackagedSshRuntimeArchives({ stageDistDir: dist, version, requireAll: mode === "complete" });
+    yield* fs.writeFile(path.join(resources,archives[0]!.fileName),new Uint8Array([1]));
+    assert.equal((yield* Effect.exit(validatePackagedSshRuntimeArchives({stageDistDir:dist,version,requireAll:mode==='complete'})))._tag,'Failure');
+  }).pipe(Effect.provide(NodeServices.layer),Effect.scoped),
+);
```

## 8. Verification commands (parent only; NOT RUN)

All commands below are grounded by direct file arguments or checked tsconfig include entries. They were not run because the delegation forbids builds/tests. Run once after all modifications; record actual exit and whether the target was observed. No repo-wide suites.

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh
../../node_modules/.bin/vp test run --config ../../vite.config.ts --dir . src/tunnel.test.ts src/runtimeArchive.test.ts src/runtimeArchiveGh.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server
../../node_modules/.bin/vp test run src/sshRemote/SshRemoteDispatch.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop
../../node_modules/.bin/vp test run src/ssh/desktopSshCliRunner.test.ts src/backend/DesktopBackendConfiguration.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts
../node_modules/.bin/vp test run --config ../vite.config.ts --dir . build-desktop-artifact.test.ts dev-runtime-archive.test.ts release-desktop-runtime.test.ts
```

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
./node_modules/.bin/vp exec tsc -p packages/ssh/tsconfig.json --noEmit
./node_modules/.bin/vp exec tsc -p apps/server/tsconfig.json --noEmit
./node_modules/.bin/vp exec tsc -p apps/desktop/tsconfig.json --noEmit --incremental false --composite false
./node_modules/.bin/vp exec tsc -p scripts/tsconfig.json --noEmit --incremental false --composite false
./node_modules/.bin/vp lint packages/ssh/src/tunnel.ts packages/ssh/src/runtimeArchive.ts packages/ssh/src/runtimeArchive.test.ts packages/ssh/src/tunnel.test.ts apps/server/src/sshRemote/SshRemoteDispatch.ts apps/server/src/sshRemote/SshRemoteDispatch.test.ts apps/server/scripts/cli.ts apps/desktop/src/main.ts apps/desktop/src/ssh/desktopSshCliRunner.ts apps/desktop/src/ssh/desktopSshCliRunner.test.ts apps/desktop/src/backend/DesktopBackendConfiguration.ts apps/desktop/src/backend/DesktopBackendConfiguration.test.ts scripts/build-desktop-artifact.ts scripts/build-desktop-artifact.test.ts scripts/dev-runtime-archive.ts scripts/dev-runtime-archive.test.ts scripts/release-desktop-runtime.test.ts
```

Compiler grounding: SSH include `["src"]`; server `["src", "vite.config.ts", "scripts", "integration", "../../scripts/lib"]`; desktop `["src", "vite.config.ts", "../../scripts/lib"]`; scripts `["**/*.ts"]`. These are package checks, not recursive monorepo checks. Override incremental/composite only to prevent verifier writes into the shared source tree. Existing failures are recorded separately and never called PASS.

Read-only rg gates:

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
rg -n 'bundledArchiveDirectory|T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR' packages/ssh/src/tunnel.ts apps/desktop/src/main.ts apps/desktop/src/ssh/desktopSshCliRunner.ts apps/desktop/src/backend/DesktopBackendConfiguration.ts apps/server/src/sshRemote/SshRemoteDispatch.ts
rg -n 'downloadRuntimeArchiveWithGh|makeDirectory|writeFile|rename|bundledArchive' packages/ssh/src/tunnel.ts packages/ssh/src/runtimeArchiveGh.ts
rg -n 'ssh-runtime-archive-dir|require-all-ssh-runtimes|SSH_RUNTIME_EXTRA_RESOURCES|validatePackagedSshRuntimeArchives' scripts/build-desktop-artifact.ts .github/workflows/release-desktop.yml
rg -n 'dev:runtime-archive|VP_NODE_VERSION|build-exe|target.*host|runtime.*archives' package.json scripts/dev-runtime-archive.ts apps/server/scripts/cli.ts
rg -n 'Upload CLI archive|Wait for SSH runtime archives|Download SSH runtime archives|Build desktop artifact|Build resource monitor before CLI archive' .github/workflows/release-desktop.yml
```

rg is an inspection/early-warning gate (E7 human review), not a semantic proof. Known bypass: an alias/new helper can move a write outside the searched strings. Residual risk requires the real-shell/write-guard and packaged-byte tests. Record reviewer path/line disposition for every match.

Parent's optional D5 build activation, after D9 and explicit build authority (not this leaf):

```sh
cd /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename
./node_modules/.bin/vp run dev:runtime-archive --home-dir /absolute/approved/goat-home --node-version 26.8.2
./node_modules/.bin/vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 --ssh-runtime-archive-dir /absolute/approved/goat-home/runtime/archives
```

These real builds are D5 evidence, not required local unit checks in wp2. An all-three local test uses fixture tars, not cross-compilation on this Mac.

## 9. Frozen fixture and risks

`packages/ssh/src/fixtures/remote-runner-baseline.json` changes in D2: **none**. Explicit preserved entries: `archive.runner`, `archive.launch`, `archive.pairing`, `mirror.runner`, `mirror.launch`, `mirror.pairing`, `node.runner`, `node.launch`, `node.pairing`. `bundledArchiveDirectory` is a local acquisition field; it does not enter generated shell bytes. Extend the existing nativeScripts baseline test's input variants with `{ ...inputs[key], bundledArchiveDirectory: "/fixture/bundle" }` and both bundle+cache. The existing native Node subprocess avoids Vite Function.toString() formatting drift.

Item 2 at `7476236e5` deliberately regenerated the reviewed runner/launch/pairing baseline; this checked-in post-010 JSON is the D2 baseline (SHA-256 `42ed378fab39fd551f77476d7fe7ef34ed11068916b30ab476ae7ea5429838c4`). Preserve all nine current entries, including exact-version installer and staged candidate bytes. Never regenerate this frozen fixture opportunistically, never copy current generated output over all nine entries, and never call a fixture delta proof of behavior. If a D2 implementation unexpectedly changes a shell entry, stop and amend this document with the exact entry/byte change and a corresponding real-shell behavior test.

Risks and dispositions:

- Private gh fallback still requires local credentials for targets not bundled; bundle hits work offline. Corrupt bundles fail with actionable errors.
- Full bundle adds three runtime archives to every installer. Local host-only packaging is permitted; release completeness is mandatory. Builds must account for the increased Windows payload file count (three archives + three sidecars); existing 80-file limit must not be silently raised. Reuse the existing counting test and measure the complete payload before choosing any limit amendment.
- Host executable version mismatch: use package version, no independent --version override. D4 reuse stays deferred.
- Atomic archive rename is not atomic two-file publication. Readers fail closed on checksum mismatch during same-version replacement; publication lock serializes dev writers only. gh/cache publishers in other processes may still race; test/read failure is preferable to accepting unverified bytes. No restart occurs on preparation error due to D1.
- Windows CLI uses the existing resolveSpawnCommand helper to sanitize .cmd/.bat arguments; verify paths with spaces using the existing Windows command helper tests and the native CI job. The POSIX stand-in test below does not establish Windows execution evidence.
- WSL mounted packaged resources may be unavailable; translation failure drops bundle input, keeps writable Linux cache/gh fallback and surfaces acquisition errors normally. No cross-OS HOME sharing.
- Release jobs now depend on three archive producer artifacts. Disabled workflows cannot prove signing/per-platform releases; report only static and wait-program tests. Do not re-enable them as part of D2.
- The new script imports existing default-home owner. D9 remains a decision outside this leaf; do not treat a recommendation as approved migration.

## 10. Proposed amendments to 000 (parent edits only)

1. D2: explicitly add `--require-all-ssh-runtimes` and CI=true strict completeness; local supplied bundles accept a nonempty supported subset. Packaging validates both stage and actual packaged resources and writes canonical `<hash>  <basename>` sidecars. Bundle readers require those canonical bytes; bundle archive version equals the packaged server version and desktop app version; desktop-only version overrides cannot substitute for package stamping.
2. D2: clarify explicit mirror behavior: ready/retained → bundle → user cache → explicit mirror if configured, otherwise local gh → upload. Bundle/cache uploads retain item 2's executable version check, then candidate verification before publication; retained runners preserve their selected version. The current frozen decision omits mirror precedence. Existing mirror semantics are preserved, while bundle/cache win.
3. D2: add the concrete `build-exe --target host` normalization in apps/server/scripts/cli.ts and explicit pre-archive Rust build in release-desktop.yml; both are prerequisites discovered in source.
4. D2: note WSL path mapping and WSLENV suffix cleanup so backend-agent dispatch also reads the packaged bundle on Windows.
5. D9 / wp3: dev archive generation inherits dev-runner's current DEFAULT_T3_HOME and worktree precedence. Resolve the default home/migration separately; no raw ~/.goat default is introduced by wp2.
6. Verifier/expected outcomes: record NOT RUN for this leaf; authoring source-grounded commands is not implementation or release evidence. D2 frozen shell fixture entries unchanged; landed item-2 deltas remain explicitly attributed to item 2 at `7476236e5`.

Document inspection: stale check at `7476236e5` revalidated all 50 named diff hunks plus the standalone workflow invocation snippet against current source, accounting for earlier proposed edits only in memory. Updated line ranges/counts, grounded the acquisition block and public-entry tests in the landed item-2 implementation, and inspected the current frozen fixture. WSLENV fold remains intact. This is document grounding only, not code/test execution.

Plan-delivery proof: only this named file was written. Read-only source/skill inspection and `git rev-parse HEAD` ran; no branch-level git, build/test, SSH, source edit, state mutation or child spawn occurred. Remaining independent architect reflection/A and all implementation/verifier results belong to parent.

## Reflection fold (A2)

- Windows WSL dedupe is deferred: keep the existing WSL staging unchanged in this unit (Windows packaging is not exercised here); disposition recorded in 002 A2.
- Size: wp5 records the archive sizes, the staged resources size and the final .app/.dmg size in evidence; release builds log them (add a log line in the staging step).

## Audit fold (cycle 2)

1. dev:runtime-archive: wrap the validation program with `Effect.scoped` before `Effect.runPromise` (spawner requires Scope).
2. Generated build-tool stand-in (lines ~1502/1519): build the program with `String.raw` (or doubled escapes) and assert it parses (`new Function` / node --check) in the test.
3. New test file (~1580): `Effect.scoped)));` → `Effect.scoped));`.
   The implementer must run tsc and the focused tests; any further syntax slips in doc hunks are fixed in place and reported.
