Stale check @480ed90da — amended count: 6 patch hunks.

Read-only source check at full HEAD `480ed90dac313828508a011f2bb1796482742a34`: all 54 original hunk before-images were present; two protocol-name anchors were ambiguous. Six resulting hunks now have current, unambiguous context, including the bundled-runtime build fields and the real-shell helper. Two context-only hunks were folded into their owning edits, leaving 52 applicable hunks. Both `*** Add File` destinations and the manual import script/test are absent; both complete replacement test files exist. This is textual source verification only; no source patch, build or test was executed. Items 2 and 1 have landed; retain their install-before-switch and bundled-runtime paths while implementing item 4.

# 030 — GOAT desktop identity, opt-in update feed, and local home

GOAT must package and open as its own desktop product without inheriting an upstream update feed or requiring Apple passkey provisioning for an ordinary local build. This work separates product, bundle and Chromium profile identities while retaining the existing Electron runtime name used by encrypted saved connections. The packaged desktop production data home is `~/.goat/desktop` (`userdata` beneath it); standalone CLI and SSH-host defaults stay `~/.goat`, and development worktree `.t3` stays unchanged. D9 now selects only whether to import a filtered snapshot (A / copy) or start fresh (B); it does not change these home defaults. The obsolete C / shared-upstream-home option is removed by audit blocker 4.

## Loop spec

- Archetype: satisfy-spec; wp3, item 4 / D3, after wp1 install-before-switch and wp2 bundled archives.
- Trigger: the parent request recorded in `000_plan.md`, and this bounded plan-writer delegation.
- Goal: packaged GOAT / GOAT (Nightly), GOAT artifacts, GOAT bundle/profile identities, no implicit update feed, locally buildable unsigned or Developer ID app, and an isolated desktop home with an explicitly selected import/fresh policy.
- Non-goals: release publishing, signing secret acquisition, notarization, provider/auth redesign, changing SSH runner installation/protocol behavior, upstream data mutation, app replacement, pushes, browser/computer use. This leaf reads source only and writes this document only; no build/test/git mutation/SSH/FSM/goal/child calls.
- Verifier: focused package commands and observable acceptance matrix below; independent review belongs to the parent. ALL execution commands in this document are NOT RUN by the leaf because the delegation prohibits execution. Source/config inspection grounds the commands; no passing exit code is claimed.
- Stop: return this complete document; parent completes wp3 only after selected D9 paths, focused checks and independent review pass.
- Memory artifact: this file; decisions remain in `000_plan.md`, source evidence in `001_research.md`.
- Expected terminal outcomes: plan delivered; implementation later PASS, or import choice/signing/credential continuity explicitly unresolved. A build-config test is not a packaged-app launch or safeStorage decryption proof.
- Escalation: parent records the user’s D9 copy/fresh answer before any import execution and handles native credential continuity if it fails. Home selection and script implementation can proceed before that operational choice; this leaf does not execute either. No unauthorized architect/child consultation was performed; parent owns that consultation and audit.
- Resource bounds: read-only source `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename`; sole leaf write `/Users/jun/Developer/new/700_projects/goat/devlog/_fin/261011_goat-ssh-runtime-supply/030_identity_updates.md`. Future implementation uses the source lane, not the documentation checkout.

## Source grounding and implementation boundary

Read `000_plan.md` D1–D5/D9 and `001_research.md` from the documentation checkout named in Resource bounds; they are absent from the source lane. At `480ed90da`, this stale check re-read every patch before-image, complete replacement test owners, home/import owners, the current SSH shell harness, and the landed bundled-runtime integration. The table below uses current source anchors; earlier research line numbers are historical. Shared HEAD/source can move; re-read the exact contexts before applying. Do not replace whole files changed by wp1/wp2, and do not treat line numbers as patch authority.

| Owner / anchor                                                                                          | Current behavior                                                                                                                                         | Planned disposition                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-desktop-artifact.ts:64,2710–2737,2788–2862`                                              | upstream bundle ID, product names, artifact prefix; ambient repo can become update feed; absent `publish` lets builder infer publishing                  | GOAT identities; canonical repo only; explicit feed opt-in; initialize `publish: null`                                                  |
| same file `:1279–1322,1688,4053–4089`                                                                   | every signed mac build resolves required Associated Domains provisioning                                                                                 | separate passkey opt-in; channel-specific entitlement app ID                                                                            |
| `apps/desktop/src/app/DesktopEnvironment.ts:96–124,173–196,245–247`                                     | display base `goat`, Alpha/Nightly stage; runtime base `T3 Code`; `.t3` default                                                                          | uppercase display names, retain runtime stage/name, own app user model ID; production `.goat/desktop`                                   |
| `DesktopUserData.ts:35–106`                                                                             | upstream dev/V2 profiles; automatically copies Windows Local State                                                                                       | own stable/nightly/dev profiles; no implicit upstream profile reads/copy                                                                |
| `DesktopClerk.ts:104–105`, `DesktopApp.ts:306–307`                                                      | both select userData; Clerk does so synchronously before ready                                                                                           | both receive same channel-aware resolver input; preserve startup ordering                                                               |
| `DesktopLegacyLocalStorage.ts:84–89`                                                                    | imports V1 upstream Local Storage on production startup                                                                                                  | skip implicit V1 import for GOAT                                                                                                        |
| `DesktopStatePaths.ts:13–32`                                                                            | default `.t3`; implicit development `/dev`, explicit home `/userdata`                                                                                    | production `.goat/desktop`; implicit dev `.t3`; explicit home/worktree precedence unchanged                                             |
| `DesktopEarlyElectronStartup.ts:57–70` / `DesktopPreReadyPlatform.ts:33–41`                             | synchronous Linux password-store settings read uses same path helper                                                                                     | pass development status into helper so pre-ready settings and later environment agree                                                   |
| `DesktopBackendConfiguration.ts:568,608–610,728–733,763–805`                                            | primary bootstrap carries `environment.baseDir` and bundled resource env; WSL drops Windows T3CODE_HOME and translates bundled path                      | primary follows selected home; retain bundled resource env, explicit overrides and WSL isolation                                        |
| `apps/server/src/cli/config.ts:319–333`                                                                 | flags > T3CODE_HOME > bootstrap home > default; derived paths below userdata                                                                             | keep precedence; desktop bootstrap supplies `.goat/desktop`, generic CLI default remains `.goat`                                        |
| `apps/server/src/os-jank.ts:105–112`                                                                    | central CLI/server default `.t3`                                                                                                                         | standalone/SSH host `.goat`; never append `/desktop` in the generic resolver                                                            |
| `apps/server/src/cli/browser.ts:55–71`                                                                  | sudo browser setup independently calculates invoking user's `.t3`                                                                                        | standalone sudo fallback `.goat`; desktop setup inherits its explicit selected home                                                     |
| `scripts/dev-runner.ts:70–72,670–679` / `packages/shared/src/devHome.ts:93–102`                         | linked worktree `.t3` overrides ambient home; dev fallback `.t3`                                                                                         | KEEP; no blanket `.t3` replacement                                                                                                      |
| `apps/desktop/src/wsl/DesktopWslEnvironment.ts:300,425,489`                                             | WSL runtime distribution cache at Linux `$HOME/.t3/wsl-runtime`                                                                                          | KEEP in this work-phase; this is a distribution cache, not primary desktop userdata; WSL server defaults follow generic os-jank `.goat` |
| `apps/server/scripts/migrate-dev-db.ts:250–258,279–329,330–453,470–613`                                 | source attached read-only; visible stopped families retained; runnable/auth tables cleared; exported runner replaces its destination DB                  | reuse exported `runMigrateDevDb` in an isolated staging home; publish only filtered DB into absent desktop target                       |
| `scripts/build-desktop-artifact.ts:936–952,1693–1705,1800–1836,2836–2843,3083–3238,4130–4145,4220–4231` | bundled-runtime options, CI requirement, validation/staging, extraResources and trailing config argument are landed                                      | KEEP; identity/feed edits must preserve all of these                                                                                    |
| `apps/desktop/src/main.ts:107–138` / `apps/desktop/src/ssh/desktopSshCliRunner.ts:14–38`                | packaged SSH runner receives resource bundle; mutable cache defaults to `<environment.baseDir>/runtime/archives`; unpackaged version uses server package | KEEP resolver and bundled path; desktop home change naturally moves only the default cache to `.goat/desktop/runtime/archives`          |
| `scripts/dev-runtime-archive.ts:31–46,96` / `.github/workflows/release-desktop.yml:421–464,530,559–560` | dev cache follows dev-runner home precedence; release hands exact-version archives to packaging                                                          | KEEP dev `.t3` behavior, archive production/sidecars and release requirement; do not turn on either new opt-in in this phase            |
| `packages/ssh/src/fixtures/remote-runner-baseline.json`                                                 | current landed fixture read; SHA256 `42ed378fab39fd551f77476d7fe7ef34ed11068916b30ab476ae7ea5429838c4`                                                   | FROZEN for wp3: no fixture edits; parent compares current bytes before/after implementation                                             |

The central server default is consumed by auth, CLI, service, browser and backend paths through `resolveBaseDir`; its GOAT default is `~/.goat` for standalone CLI/SSH hosts. Only the desktop selector adds `/desktop`, and the primary desktop backend receives it through `bootstrap.t3Home`. An explicit `--base-dir` or `T3CODE_HOME` continues to work, including `.t3` deliberately chosen by an operator. Do not make generic server defaults depend on the desktop's Chromium profile or product channel.

## File map and field chains

All paths in the following patches are relative to the source lane. Apply with the `apply_patch` tool from that lane after the parent revalidates wp1/wp2 changes. Patch blocks use that tool's `*** Begin Patch` format, rather than shell interpolation. No source patch is applied by this leaf. At `480ed90da`, `createBuildConfig` ends with `wslRuntimeBundled = false`, `arch?`, `sshRuntimeBundled = false`; its staged-package caller passes all three. Keep the SSH archive input/requirement fields, `SSH_RUNTIME_EXTRA_RESOURCES`, archive validation/staging and payload checks. `main.ts`, `ssh/desktopSshCliRunner.ts`, `DesktopBackendConfiguration.ts`, the release workflows and `dev-runtime-archive.ts` need no identity source edits. The existing backend bundle env and WSL translation remain independent of the newly selected desktop home.

| Action                   | Path                                                                                                                                    | Purpose                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| MODIFY                   | `scripts/build-desktop-artifact.ts`                                                                                                     | identity + feed policy + passkey opt-in                                                       |
| MODIFY                   | `scripts/build-desktop-artifact.test.ts`                                                                                                | config, feed rejection, signing/provisioning and channel tests                                |
| MODIFY                   | `apps/desktop/src/app/DesktopEnvironment.ts`                                                                                            | display + Windows ID; production desktop home consumer                                        |
| MODIFY                   | `apps/desktop/src/app/DesktopUserData.ts`                                                                                               | own channel-aware profile, remove implicit upstream migration                                 |
| MODIFY                   | `apps/desktop/src/app/DesktopLegacyLocalStorage.ts`                                                                                     | disable upstream V1 import for GOAT                                                           |
| MODIFY                   | `apps/desktop/src/app/DesktopEnvironment.test.ts`                                                                                       | visible identity and selected home                                                            |
| MODIFY                   | `apps/desktop/src/app/DesktopAppIdentity.test.ts`                                                                                       | preserve runtime identity; visible names and own profiles                                     |
| MODIFY                   | `apps/desktop/src/app/DesktopUserData.test.ts`                                                                                          | replace old migration cases with channel coexistence and upstream preservation                |
| MODIFY                   | `apps/desktop/src/app/DesktopPreReadyFileSystem.test.ts`                                                                                | replace upstream migration/read expectation with own profile/no-copy proof                    |
| MODIFY                   | `apps/desktop/src/app/DesktopClerk.test.ts`                                                                                             | own profile installed before Clerk bridge; keep synchronous ordering proof                    |
| NEW                      | `apps/desktop/src/app/DesktopLegacyLocalStorage.test.ts`                                                                                | GOAT starts without reading/importing upstream V1 data; no such owner test exists yet         |
| MODIFY                   | `apps/desktop/src/app/DesktopStatePaths.ts`                                                                                             | production `.goat/desktop`, implicit dev `.t3`                                                |
| MODIFY                   | `apps/desktop/src/app/DesktopEarlyElectronStartup.ts`                                                                                   | synchronize early path with production/dev mode                                               |
| MODIFY                   | `apps/desktop/src/app/DesktopEarlyElectronStartup.test.ts`                                                                              | actual settings read path/preference                                                          |
| MODIFY if still upstream | `apps/server/src/os-jank.ts`, `apps/server/src/cli/browser.ts`                                                                          | standalone/SSH/sudo fallback `.goat`; no desktop suffix                                       |
| MODIFY                   | `apps/server/src/os-jank.test.ts`, `apps/server/src/cli/config.test.ts`, `apps/desktop/src/backend/DesktopBackendConfiguration.test.ts` | generic `.goat` versus desktop bootstrap `.goat/desktop`, isolated home and precedence proofs |
| NEW if absent            | `apps/server/src/cli/browser.test.ts`                                                                                                   | sudo home special-case behavior; no such test exists yet                                      |
| MODIFY test only         | `packages/ssh/src/tunnel.test.ts`                                                                                                       | real shell isolation regression; generated script bytes stay frozen                           |
| NEW                      | `scripts/import-desktop-home.ts`                                                                                                        | explicit manual one-time filtered import; reuse existing migration runner, no startup hook    |
| NEW                      | `scripts/import-desktop-home.test.ts`                                                                                                   | real isolated DB retention/exclusion, source preservation and no-overwrite proofs             |
| READ / reuse             | `apps/server/scripts/migrate-dev-db.ts`, `apps/server/scripts/migrate-dev-db.test.ts`                                                   | existing filtering/migration logic and fixture patterns; preserve dev rebuild semantics       |
| DELETE                   | none                                                                                                                                    | old profile directories and upstream data stay present                                        |

New value chains:

- `T3CODE_DESKTOP_UPDATE_FEED_ENABLED`: producer is an explicit build environment (default false); decoded as `Config.Boolean` in existing feed resolver; consumer is `createBuildConfig.publish` -> staged package JSON -> electron-builder `app-update.yml` -> existing `DesktopUpdates` feed reader. No WS/RPC serialization or client enum is involved. Do not set it in local or currently unpublished builds. Future authorized release workflow can set it only with a usable GOAT feed.
- `T3CODE_DESKTOP_MAC_PASSKEYS`: explicit build environment -> `BuildEnvConfig.macPasskeys` -> resolved build option -> signing-plan resolver -> provisioning/entitlements and existing `t3codeWebAuthn` package metadata -> `preview/Passkeys.ts` decoder. No CLI flag is needed in this minimal version; opt in with the environment, independently of `--signed`. No changes to Clerk sign-in/WebAuthn bridge API are proposed.
- `appVersion` passed to profile resolver: already created in `MakeDesktopEnvironmentInput`; no new environment field -> whole environment already passed by both `DesktopClerk` and `DesktopAppIdentity` -> select stable/nightly profile. Add the required field to direct test callers. No wire or persisted profile enum.
- Bundle app ID: version -> `resolveDesktopAppId` -> build config and passkey signing config -> signed entitlements; Windows `appUserModelId` uses matching stable/nightly IDs. OAuth URL scheme names and internal `t3codeWebAuthn` metadata keys stay compatible; changing those is a separate contract task.
- Desktop development boolean: desktop config `devServerUrl` and early env `VITE_DEV_SERVER_URL` -> `resolveDesktopBaseDir`; no persisted/transport field. Worktree `.t3` is an explicit input from dev-runner and wins unchanged.

Feed restriction tier: E7 script policy in the packaging path. Known bypass: editing the build script/staged JSON or separately invoking electron-builder. Residual risk: old installed apps retain their old feed; this plan affects newly packaged builds. It is a build-path guard, not a security boundary against a maintainer editing the source.

## Ordered implementation

1. Implement canonical feed policy and explicit `publish: null`, with config tests.
2. Apply packaged product/bundle identities and entitlement app ID resolver.
3. Make provisioned macOS passkeys opt-in independently of code signing; verify resolved plan behavior without running signing.
4. Apply visible GOAT names and stable/nightly/dev Chromium profiles; preserve existing runtime names. Remove implicit upstream imports and adapt their behavior tests.
5. Apply desktop production `.goat/desktop` selection and keep standalone/SSH `.goat` plus dev-worktree `.t3`. Implement the manual filtered-import script and focused tests. Record D9-A copy versus D9-B fresh; only A permits the operator to run import in wp5 before first launch.
6. Add cross-owner tests, execute focused commands, review rg results against the allowlist, and hand back wp3 evidence. App packaging/installation and native credential proof happen in wp5.

## 1. Feed policy: canonical repo plus explicit published-feed opt-in

`GITHUB_REPOSITORY=pingdotgg/t3code`, another fork, an empty string or malformed repo must never supply GOAT's updater. Even `goat-si/goat` stays off until a build explicitly enables the feed. An explicit invalid repository does not fall back to ambient metadata. `mockUpdates` remains an explicit local test path and takes priority over a real feed. PR/preview builds always have `publish: null`, including with mock mode or feed opt-in.

```patch
*** Begin Patch
*** Update File: scripts/build-desktop-artifact.ts
@@
-const DESKTOP_APP_ID = "com.t3tools.t3code";
+const DESKTOP_APP_ID = "si.goat.desktop";
+const DESKTOP_UPDATE_REPOSITORY = "goat-si/goat";
@@
   const env = yield* Config.all({
     updateRepository: Config.String("T3CODE_DESKTOP_UPDATE_REPOSITORY").pipe(Config.option),
     githubRepository: Config.String("GITHUB_REPOSITORY").pipe(Config.option),
+    enabled: Config.Boolean("T3CODE_DESKTOP_UPDATE_FEED_ENABLED").pipe(Config.withDefault(false)),
   });
-  const rawRepo = (
-    Option.getOrUndefined(env.updateRepository)?.trim() ||
-    Option.getOrUndefined(env.githubRepository)?.trim() ||
-    ""
-  ).trim();
-  if (!rawRepo) return undefined;
+  if (!env.enabled) return undefined;
+  const explicit = Option.getOrUndefined(env.updateRepository)?.trim();
+  const ambient = Option.getOrUndefined(env.githubRepository)?.trim();
+  const rawRepo = explicit || ambient || "";
+  if (rawRepo !== DESKTOP_UPDATE_REPOSITORY) return undefined;
@@
   arch?: typeof BuildArch.Type,
   sshRuntimeBundled = false,
 ) {
   const buildConfig: Record<string, unknown> = {
-    appId: DESKTOP_APP_ID,
+    appId: resolveDesktopAppId(version),
     productName: resolveDesktopProductName(version),
-    artifactName: "T3-Code-${version}-${arch}.${ext}",
+    artifactName: "GOAT-${version}-${arch}.${ext}",
+    // Disable electron-builder's ambient GitHub inference for unpublished builds.
+    publish: null,
@@
   const updateChannel = resolveDesktopUpdateChannel(version);
   if (!isDesktopPreviewVersion(version)) {
-    const publishConfig = yield* resolveGitHubPublishConfig(updateChannel);
-    if (publishConfig) {
-      buildConfig.publish = [publishConfig];
-    } else if (mockUpdates) {
+    if (mockUpdates) {
       buildConfig.publish = [
         {
           provider: "generic",
           url: resolveMockUpdateServerUrl(mockUpdateServerPort),
         },
       ];
+    } else {
+      const publishConfig = yield* resolveGitHubPublishConfig(updateChannel);
+      if (publishConfig) buildConfig.publish = [publishConfig];
     }
   }
*** End Patch
```

The existing repo split/owner/repo return code following the replaced resolver block remains. Whitespace is normalized, exact canonical spelling is required. Keep `--publish never` in the builder invocation: adding feed metadata is distinct from uploading a release.

## 2. Product, artifact and bundle identities

```patch
*** Begin Patch
*** Update File: scripts/build-desktop-artifact.ts
@@
 export function resolveDesktopProductName(version: string): string {
   return resolveDesktopUpdateChannel(version) === "nightly"
-    ? "T3 Code (Nightly)"
-    : (desktopPackageJson.productName ?? "T3 Code");
+    ? "GOAT (Nightly)"
+    : "GOAT";
 }
+
+export function resolveDesktopAppId(version: string): string {
+  return resolveDesktopUpdateChannel(version) === "nightly"
+    ? `${DESKTOP_APP_ID}.nightly`
+    : DESKTOP_APP_ID;
+}
@@
         NSLocalNetworkUsageDescription:
-          "T3 Code connects to devices on your local network for remote environments and commands run by terminals and coding agents.",
+          "GOAT connects to devices on your local network for remote environments and commands run by terminals and coding agents.",
         NSScreenCaptureUsageDescription:
-          "T3 Code captures the active window when you use the window capture shortcut.",
+          "GOAT captures the active window when you use the window capture shortcut.",
@@
       protocols: [
         {
-          name: "T3 Code",
+          name: "GOAT",
           schemes: ["t3code", "t3code-dev"],
         },
         // Lets people choose T3 Code as their default web browser, which opens
@@
       protocols: [
         {
-          name: "T3 Code",
+          name: "GOAT",
           schemes: ["t3code", "t3code-dev"],
         },
       ],
       desktop: {
@@
     description:
-      "T3 Code is an open-source desktop app for coding agents. Work with your existing agent subscriptions, review code changes, and run commands in your projects. Connect from desktop, web, or mobile to continue working remotely.",
+      "GOAT is an open-source desktop app for coding agents. Work with your existing agent subscriptions, review code changes, and run commands in your projects. Connect from desktop, web, or mobile to continue working remotely.",
@@
-  Command.withDescription("Build a desktop artifact for T3 Code."),
+  Command.withDescription("Build a desktop artifact for GOAT."),
*** End Patch
```

The two protocol-name replacements now include distinct macOS comment and Linux `desktop` contexts, respectively; each before-image matches exactly once at `480ed90da`. Do not rename the schemes (`t3code`, `t3code-dev`), staged npm package name, Linux executable `t3code`, vendored workspace package names or AppStream path here. Those are compatibility surfaces; the requested product, bundle ID and artifact identity do not require a global string replacement. Linux desktop portal/WMClass currently retain their existing ID; full coexistence with an upstream Linux installation would additionally need coordinated early/late portal and AppStream changes. Parent should record that limitation rather than claim complete Linux OS-registration separation from the requested bundle/profile work.

## 3. Provisioned passkeys opt-in

Add only an environment-controlled option; no new CLI flag/transport schema. `--signed` still enables existing Developer ID signing, while `T3CODE_DESKTOP_MAC_PASSKEYS=true` additionally requests Associated Domains provisioning. Unsigned local builds ignore a passkey opt-in because unsigned associated-domain entitlements cannot be provisioned. Missing profile/team/domain information fails only the explicitly opted-in signed mac build. An opted-in nightly uses `si.goat.desktop.nightly` for application/keychain entitlement values.

```patch
*** Begin Patch
*** Update File: scripts/build-desktop-artifact.ts
@@
 interface ResolvedBuildOptions {
   readonly platform: typeof BuildPlatform.Type;
   readonly target: string;
   readonly arch: typeof BuildArch.Type;
   readonly version: string | undefined;
   readonly outputDir: string;
   readonly skipBuild: boolean;
   readonly keepStage: boolean;
   readonly signed: boolean;
+  readonly macPasskeys: boolean;
   readonly verbose: boolean;
   readonly mockUpdates: boolean;
   readonly mockUpdateServerPort: number | undefined;
   readonly wslRuntime: string | undefined;
   readonly sshRuntimeArchiveDir: string | undefined;
   readonly requireAllSshRuntimes: boolean;
 }
@@
   signed: Config.Boolean("T3CODE_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
+  macPasskeys: Config.Boolean("T3CODE_DESKTOP_MAC_PASSKEYS").pipe(Config.withDefault(false)),
@@
   return {
     platform,
     target,
     arch,
     version,
     outputDir,
     skipBuild,
     keepStage,
     signed,
+    macPasskeys: env.macPasskeys,
     verbose,
     mockUpdates,
     mockUpdateServerPort,
     wslRuntime,
     sshRuntimeArchiveDir,
     requireAllSshRuntimes,
   } satisfies ResolvedBuildOptions;
@@
 export function resolveMacPasskeySigningConfiguration(
   env: Readonly<Record<string, string | undefined>>,
+  appId = DESKTOP_APP_ID,
 ): MacPasskeySigningConfiguration {
@@
   return {
-    appId: DESKTOP_APP_ID,
+    appId,
     teamId,
     rpDomains: uniqueRpDomains,
     provisioningProfilePath,
   };
 }
+
+export function resolveOptionalMacPasskeySigningConfiguration(
+  input: {
+    readonly platform: typeof BuildPlatform.Type;
+    readonly signed: boolean;
+    readonly macPasskeys: boolean;
+    readonly version: string;
+  },
+  env: Readonly<Record<string, string | undefined>>,
+): MacPasskeySigningConfiguration | undefined {
+  if (input.platform !== "mac" || !input.signed || !input.macPasskeys) return undefined;
+  return resolveMacPasskeySigningConfiguration(env, resolveDesktopAppId(input.version));
+}
@@
-  const configuredMacPasskeySigning =
-    options.platform === "mac" && options.signed
-      ? yield* Effect.try({
-          try: () => resolveMacPasskeySigningConfiguration(loadRepoEnv({ repoRoot })),
-          catch: MacPasskeySigningConfigurationResolutionError.fromCause,
-        })
-      : undefined;
+  const configuredMacPasskeySigning = yield* Effect.try({
+    try: () => resolveOptionalMacPasskeySigningConfiguration(
+      { ...options, version: appVersion },
+      loadRepoEnv({ repoRoot }),
+    ),
+    catch: MacPasskeySigningConfigurationResolutionError.fromCause,
+  });
*** End Patch
```

Keep all existing provisioning-file existence checks, authorized-entitlement checks, rendering and staged `t3codeWebAuthn` metadata conditional on `configuredMacPasskeySigning`. With no provisioning, that metadata is absent; `preview/Passkeys.ts` already disables the entitlement-dependent mac bridge. This does not claim Clerk-account passkeys or macOS native WebAuthn are enabled on an unsigned app. Signed builds without opt-in keep the normal code-signing path and no associated-domain profile.

## 4. Visible names and Chromium profiles; retain runtime name

Stable visual name becomes `GOAT`; nightly `GOAT (Nightly)`; development `GOAT (Dev)`. Keep the existing internal Alpha stage for stable runtime naming: `T3 Code Alpha`, `T3 Code Nightly`, `T3 Code Dev`. Do not change `DESKTOP_RUNTIME_APP_BASE_NAME`, `DesktopAppIdentity.configure` or the runtime stage calculation. Renaming those can change macOS Keychain/Linux secret-store selection and make encrypted bearer tokens unreadable. Profile isolation is separate from server-home migration.

```patch
*** Begin Patch
*** Update File: apps/desktop/src/app/DesktopEnvironment.ts
@@
-const APP_BASE_NAME = "goat";
+const APP_BASE_NAME = "GOAT";
@@
     baseName: APP_BASE_NAME,
     stageLabel,
-    displayName: `${APP_BASE_NAME} (${stageLabel})`,
+    displayName: stageLabel === "Alpha" ? APP_BASE_NAME : `${APP_BASE_NAME} (${stageLabel})`,
@@
     appUserModelId: Option.getOrElse(config.appUserModelIdOverride, () =>
-      isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code",
+      isDevelopment
+        ? "si.goat.desktop.dev"
+        : isNightlyDesktopVersion(input.appVersion)
+          ? "si.goat.desktop.nightly"
+          : "si.goat.desktop",
     ),
*** End Patch
```

Replace only `resolveUserDataPath` (the exported error class may remain for source compatibility during integration). Remove its now-unused `effect/FileSystem` import; retain Path/Effect, PlatformError/Schema used by the class. The resolver remains synchronous under the pre-ready Path layer; it does not create/read/migrate anything, so Clerk bridge startup ordering is preserved.

```patch
*** Begin Patch
*** Update File: apps/desktop/src/app/DesktopUserData.ts
@@
-import * as FileSystem from "effect/FileSystem";
@@
 import * as Schema from "effect/Schema";
+import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";
@@
     readonly isDevelopment: boolean;
     readonly platform: NodeJS.Platform;
+    readonly appVersion: string;
   }) {
-    const fs = yield* FileSystem.FileSystem;
     const path = yield* Path.Path;
-    const names = input.isDevelopment
-      ? { current: "t3code-dev", legacy: "T3 Code (Dev)" }
-      : { current: "t3code-v2", legacy: "T3 Code (Alpha)" };
-    const destinationPath = path.join(input.appDataDirectory, names.current);
-    const legacyPath = path.join(input.appDataDirectory, names.legacy);
-    const inspect = (resourcePath: string) =>
-      fs
-        .exists(resourcePath)
-        .pipe(
-          Effect.mapError((cause) =>
-            DesktopUserDataInitializationError.fromFileSystem(cause, "inspect", resourcePath),
-          ),
-        );
-    if (input.isDevelopment) {
-      return (yield* inspect(legacyPath)) ? legacyPath : destinationPath;
-    }
-    // Chromium databases require their own profile for each running version.
-    if (input.platform !== "win32") return destinationPath;
-    const destinationState = path.join(destinationPath, "Local State");
-    if (yield* inspect(destinationState)) return destinationPath;
-    const legacyState = path.join(legacyPath, "Local State");
-    const sourceState = (yield* inspect(legacyState))
-      ? legacyState
-      : path.join(input.appDataDirectory, "t3code", "Local State");
-    if (!(yield* inspect(sourceState))) return destinationPath;
-    // Windows safeStorage keys live here. Copy only these preferences, never locked databases.
-    const state = yield* fs
-      .readFileString(sourceState)
-      .pipe(
-        Effect.mapError((cause) =>
-          DesktopUserDataInitializationError.fromFileSystem(cause, "read", sourceState),
-        ),
-      );
-    yield* fs
-      .makeDirectory(destinationPath, { recursive: true })
-      .pipe(
-        Effect.mapError((cause) =>
-          DesktopUserDataInitializationError.fromFileSystem(
-            cause,
-            "create-directory",
-            destinationPath,
-          ),
-        ),
-      );
-    yield* fs.writeFileString(destinationState, state, { flag: "wx" }).pipe(
-      Effect.catchIf(
-        (error) => error.reason._tag === "AlreadyExists",
-        () => Effect.void,
-      ),
-      Effect.mapError((cause) =>
-        DesktopUserDataInitializationError.fromFileSystem(cause, "write", destinationState),
-      ),
-    );
-    return destinationPath;
+    const profile = input.isDevelopment
+      ? "goat-desktop-dev"
+      : isNightlyDesktopVersion(input.appVersion)
+        ? "goat-desktop-nightly"
+        : "goat-desktop";
+    return path.join(input.appDataDirectory, profile);
   },
 );
*** Update File: apps/desktop/src/app/DesktopLegacyLocalStorage.ts
@@
-    // Development already shares its profile between versions.
-    if (environment.isDevelopment) return;
+    // GOAT uses its own profile; importing upstream V1 preferences is never implicit.
+    if (environment.isDevelopment || environment.branding.baseName === "GOAT") return;
*** End Patch
```

The helper's verified import path is `../updates/updateChannels.ts`, shared with `DesktopEnvironment.ts`. Do not add a second nightly regex.

Runtime retention does not prove credential portability. macOS/Linux runtime-name keys, Windows `Local State` keys, the app’s bundle identity and Chromium partitions differ. Both copy/fresh choices use new browser/Clerk profiles, and D9-A imports only filtered database history; it does not copy encrypted saved-environment registries, secrets or Windows Local State. Re-authentication is the bounded path here. A future separately authorized credential migration would need native safeStorage proof in wp5 and must never silently overwrite/drop records on decryption failure. Copying IndexedDB/browser profiles or enabling another user’s passkeys is outside scope.

## 5. D9-A copy — explicit filtered one-time import

Implement `scripts/import-desktop-home.ts` as the smallest manual opt-in entry point. It imports a filtered snapshot only; it is never called by desktop startup, packaging, a service, or SSH. The user’s copy/fresh answer gates execution in wp5. No first-run prompt or new product command/RPC is needed.

Proposed operator command from the source lane (NOT RUN by this leaf):

```sh
node scripts/import-desktop-home.ts --from "$HOME/.t3"
```

`--from <dir>` is mandatory and denotes the chosen source data home, containing `userdata/statev2.sqlite`; no implicit source fallback. Run as the local user without sudo, before starting the packaged desktop. The production destination is fixed to the current account’s `~/.goat/desktop/userdata/statev2.sqlite`; ignore ambient `T3CODE_HOME` and never write standalone/SSH-host `~/.goat/userdata` or a worktree `.t3`. A home-directory dependency may be injected into the exported operation for isolated tests, without adding a production destination override.

### Reuse and filtering contract

Read and reuse `apps/server/scripts/migrate-dev-db.ts`, specifically exported `runMigrateDevDb`. Its `copySourceSlice` attaches SQLite with `?mode=ro`, copies schema/visible families transactionally, and skips `CLEARED_TABLES`; `pruneSnapshot` excludes recovery/live/failed-run families and retains visible stopped families, forks and subagents together. Migrations and slot-collision checks run on the private snapshot before publication. Do not create a second SQL filter or use an unfiltered SQLite backup as the imported result.

Keep eligible nondeleted projects and stopped thread families, their history/events and necessary provider bindings. Exclude deleted/archived/settled and live/recoverable families as the existing logic does. The dev command defaults to 5 projects and 10 families per project; do not silently impose those sample limits on a personal import. The wrapper passes explicit limits covering all eligible projects/families (derive counts from the private snapshot, at least one project and nonnegative family limit). Print actual retained project/thread/event counts and exclusions after completion.

The existing clearing contract includes `scheduled_tasks`, `orchestration_v2_effect_outbox`, `orchestration_v2_thread_launch_workflows`, `orchestration_command_receipts`, `provider_session_runtime`, `auth_sessions`, and `auth_pairing_links`. These must be empty in the imported DB. Pending work/commands and queued/recovery families must not be resumed on first boot. Retaining a stopped thread’s durable history is intentional; do not confuse historical command events with runnable commands. Revalidate the owning schema for any additional runnable table before implementation and report a filtering gap to parent rather than hand-writing an incomplete purge.

### Source preservation and no-overwrite publication

1. Validate the selected source has a real `userdata/statev2.sqlite`; reject symlink/path aliasing between source, staging and target. V1-only source is a clear failure, with no automatic legacy import. Check the fixed target before doing work: any existing `statev2.sqlite` (including a dangling symlink) refuses import; an existing desktop directory without that DB is allowed. Existing WAL/SHM files or a live desktop runtime also require refusal rather than cleanup.
2. Parent establishes source quiescence for the wp5 operation and takes before/after source hashes. Make a private temporary snapshot of only SQLite main/WAL/SHM bytes while it is quiescent, then open that private copy. This avoids SQLite coordination/checkpoint writes to the original source while preserving committed WAL content. No source migration, checkpoint, deletion or settings write; never use `immutable=1` against an active WAL DB. The intermediate private snapshot is discarded and is never published as the imported DB.
3. Invoke `runMigrateDevDb` with `source` pointing to that private snapshot, `baseDir` pointing to a separate private staging output home, explicit retention limits, and `sharedHome` bound to the selected source home. The existing runner deliberately removes/replaces destination database files; NEVER pass `~/.goat/desktop` as its `baseDir`. Reusing it in staging preserves the dev command’s behavior without exposing the desktop target to replacement.
4. Verify the staged DB with `PRAGMA integrity_check`, retained stopped families and zero rows in runnable/auth tables. Fully close SQLite connections and checkpoint only the staged DB so the published main file includes all data. Create the destination userdata directory if absent, recheck destination absence, then publish the completed DB with an atomic no-replace operation on the same filesystem (for example a hard link from an owned sibling staging file, failing on EEXIST). A plain overwriting rename or a precheck followed by nonexclusive copy is insufficient. Publish only `statev2.sqlite` with mode `0600`, preserve existing unrelated target files, and do not remove target DB/WAL/SHM on failure.
5. Clean up only temporary paths owned by this invocation. A migration/filter/integrity/publication failure must leave source and any existing target DB untouched. Repeated execution refuses an existing DB without overwriting it. Do not use PID-based killing or restart any runtime.

Automatically copying `secrets`, settings, saved-environment registries, Chromium/Local State, browser databases, `server-runtime.json`, PID/port/lock files, service configuration or runtime binaries is excluded. The snapshot import transfers projects/stopped history only; saved connections and provider credentials may need to be re-added/re-authenticated. Any later credential/settings migration needs a separate explicit choice and preservation proof.

### wp5 isolated rehearsal and execution gate

Use the owning server migration fixtures to create realistic temporary source DBs containing stopped families and children, a live/queued/recoverable family, scheduled tasks, command receipts/pending launch work, outbox effects, provider runtime, and auth/pairing rows. Include a committed WAL row and more than 5 projects / 10 stopped families to prove the import does not apply dev sample caps. Keep distinct secrets/settings/runtime sentinel files beside the DB. Assert retained families/history, all runnable/auth tables empty, integrity success, sentinel files absent from the destination and complete source-byte/hash preservation. Test missing source, V1-only source, symlink/alias, migration slot collision, existing destination DB, a destination appearing during publication, target directory existing without a DB, and failed import cleanup. Re-run to prove nonzero refusal and unchanged destination bytes. Use temporary injected home paths exclusively.

After isolated proof, wp5 runs the manual command against the operator-selected source only if the user selected D9-A copy; record the selection, paths, counts, exclusion/integrity checks and source preservation evidence. An unanswered choice blocks actual import execution, not home-selector/script implementation. D9-B fresh skips the command entirely.

## D9-B fresh

Apply the same production home source patches and implement the opt-in script, but do not invoke it. Normal packaged desktop startup creates fresh `~/.goat/desktop/userdata`; standalone CLI and SSH-host defaults remain `~/.goat`. Upstream `.t3` remains untouched. Explicit overrides and development worktree `.t3` remain authoritative. Re-add/re-authenticate saved connections as needed. No implicit source inspection or import occurs on first launch.

## Shared home source patches — desktop versus standalone/SSH

```patch
*** Begin Patch
*** Update File: apps/desktop/src/app/DesktopStatePaths.ts
@@
 export function resolveDesktopBaseDir(input: {
   readonly homeDirectory: string;
   readonly joinPath: JoinPath;
   readonly t3Home: Option.Option<string>;
+  readonly isDevelopment: boolean;
 }): string {
   return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
-    input.joinPath(input.homeDirectory, ".t3"),
+    input.isDevelopment
+      ? input.joinPath(input.homeDirectory, ".t3")
+      : input.joinPath(input.homeDirectory, ".goat", "desktop"),
   );
 }
*** Update File: apps/desktop/src/app/DesktopEnvironment.ts
@@
   const baseDir = resolveDesktopBaseDir({
     homeDirectory,
     joinPath: path.join,
     t3Home: config.t3Home,
+    isDevelopment,
   });
*** Update File: apps/desktop/src/app/DesktopEarlyElectronStartup.ts
@@
   const baseDir = resolveDesktopBaseDir({
     homeDirectory: input.homeDirectory,
     joinPath: input.joinPath,
     t3Home,
+    isDevelopment: isDevelopmentEnvironment(input.env),
   });
*** Update File: apps/server/src/os-jank.ts
@@
   if (!raw || raw.trim().length === 0) {
-    return join(yield* HostProcess.HomeDirectory, ".t3");
+    return join(yield* HostProcess.HomeDirectory, ".goat");
   }
*** Update File: apps/server/src/cli/browser.ts
@@
- * unspecified home falls back to the invoking user's `~/.t3`.
+ * unspecified home falls back to the invoking user's `~/.goat`.
@@
-  return home ? path.join(home, ".t3") : yield* resolveBaseDir(undefined);
+  return home ? path.join(home, ".goat") : yield* resolveBaseDir(undefined);
*** End Patch
```

No changes to `resolveDesktopStateDir`, explicit `T3CODE_HOME`, primary bootstrap envelope or backend launch arguments. Existing derived paths remain `<selected base>/userdata` (including settings, saved-environments, statev2.sqlite, logs, browser-artifacts). An implicit development run still uses `.t3/dev`; an explicit worktree home still uses `<worktree>/.t3/userdata`. Windows primary desktop home is `%USERPROFILE%/.goat/desktop`; standalone CLI and SSH hosts use `~/.goat`, and WSL resolves its own Linux home; do not force a `/mnt/c` home into WSL.

## 6. Behavioral tests and concrete changes

Add the following cases using existing owners/layers/harnesses. Assertions observe produced packaging config, real files, actual settings reads, bootstrapped server config or executed shell behavior. Do not substitute grep-only tests for execution, static markup tests, or tests of newly factored helper wiring.

### Build config tests

In `scripts/build-desktop-artifact.test.ts`, add the new optional signing resolver to the existing import list. Change product expectations to `GOAT` and `GOAT (Nightly)`. Replace the original feed test's upstream repo/env with canonical repo + explicit opt-in, and its expected owner/repo with `goat-si`/`goat`. Update preview assertions from absent property to `publish === null`; its stable release case should opt in with canonical repo. Add rejection cases below, not merely replacements of snapshots.

```patch
*** Begin Patch
*** Update File: scripts/build-desktop-artifact.test.ts
@@
   resolveMacPasskeySigningConfiguration,
+  resolveOptionalMacPasskeySigningConfiguration,
@@
-    assert.equal(resolveDesktopProductName("0.0.17"), "T3 Code (Alpha)");
-    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "T3 Code (Nightly)");
+    assert.equal(resolveDesktopProductName("0.0.17"), "GOAT");
+    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "GOAT (Nightly)");
@@
-      assert.notProperty(preview, "publish");
-      assert.notProperty(previewChannel, "publish");
+      assert.strictEqual(preview.publish, null);
+      assert.strictEqual(previewChannel.publish, null);
@@
 it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
+  it.effect("disables feeds for local builds and unrelated repositories", () =>
+    Effect.gen(function* () {
+      for (const env of [
+        {},
+        { GITHUB_REPOSITORY: "pingdotgg/t3code" },
+        { GITHUB_REPOSITORY: "goat-si/goat" },
+        { T3CODE_DESKTOP_UPDATE_REPOSITORY: "goat-si/goat" },
+        { T3CODE_DESKTOP_UPDATE_FEED_ENABLED: "true", GITHUB_REPOSITORY: "some/fork" },
+        { T3CODE_DESKTOP_UPDATE_FEED_ENABLED: "true", GITHUB_REPOSITORY: "goat-si/goat", T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code" },
+        { T3CODE_DESKTOP_UPDATE_FEED_ENABLED: "true", T3CODE_DESKTOP_UPDATE_REPOSITORY: "goat-si/goat/extra" },
+      ]) {
+        const config = yield* createBuildConfig("mac", "dmg", "1.2.3", false, false, undefined, undefined)
+          .pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));
+        assert.strictEqual(config.publish, null);
+        assert.equal(config.appId, "si.goat.desktop");
+        assert.equal(config.productName, "GOAT");
+        assert.equal(config.artifactName, "GOAT-${version}-${arch}.${ext}");
+      }
+    }),
+  );
+
+  it.effect("configures only an opted-in canonical nightly feed and keeps previews off", () =>
+    Effect.gen(function* () {
+      const feed = yield* createBuildConfig("mac", "dmg", "1.2.3-nightly.20261011.1", false, false, undefined, undefined);
+      assert.equal(feed.appId, "si.goat.desktop.nightly");
+      assert.deepStrictEqual(feed.publish, [{ provider: "github", owner: "goat-si", repo: "goat", releaseType: "prerelease", channel: "nightly" }]);
+      for (const version of ["1.2.3-pr.4.1", "1.2.3-preview.20261011.1"]) {
+        const preview = yield* createBuildConfig("mac", "dmg", version, false, true, 3999, undefined);
+        assert.strictEqual(preview.publish, null);
+      }
+      const mock = yield* createBuildConfig("mac", "dmg", "1.2.3", false, true, 3999, undefined);
+      assert.deepStrictEqual(mock.publish, [{ provider: "generic", url: "http://localhost:3999" }]);
+    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {
+      GITHUB_REPOSITORY: " goat-si/goat ", T3CODE_DESKTOP_UPDATE_FEED_ENABLED: "true",
+    } })))),
+  );
+
+  it("requires provisioning only for explicitly opted-in signed macOS builds", () => {
+    const local = { platform: "mac" as const, signed: true, macPasskeys: false, version: "1.2.3" };
+    assert.isUndefined(resolveOptionalMacPasskeySigningConfiguration(local, {}));
+    assert.isUndefined(resolveOptionalMacPasskeySigningConfiguration({ ...local, signed: false, macPasskeys: true }, {}));
+    assert.isUndefined(resolveOptionalMacPasskeySigningConfiguration({ ...local, platform: "linux", macPasskeys: true }, {}));
+    assert.throws(() => resolveOptionalMacPasskeySigningConfiguration({ ...local, macPasskeys: true }, {}));
+    const entitled = resolveOptionalMacPasskeySigningConfiguration({ ...local, macPasskeys: true, version: "1.2.3-nightly.20261011.1" }, {
+      T3CODE_APPLE_TEAM_ID: "ABC1234567", T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/goat.provisionprofile", T3CODE_CLERK_PASSKEY_RP_DOMAINS: "clerk.example.com",
+    });
+    assert.equal(entitled?.appId, "si.goat.desktop.nightly");
+  });
+
+  it.effect("keeps normal signing available without a passkey profile", () =>
+    Effect.gen(function* () {
+      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", true, false, undefined, undefined);
+      const mac = config.mac as Record<string, unknown>;
+      assert.match(String(mac.sign), /[\\/]scripts[\\/]sign-macos\.ts$/);
+      assert.notProperty(mac, "provisioningProfile");
+      assert.notProperty(mac, "entitlements");
+    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
+  );
*** End Patch
```

Keep the landed bundled-runtime tests and their complete options literals, including `sshRuntimeArchiveDir` and `requireAllSshRuntimes`; preserve the trailing `sshRuntimeBundled` argument and extraResources assertions. The new feed/identity cases use the default false bundle argument intentionally. Do not replace the full build-test file or recreate an options literal from the pre-wp2 plan.

Additional exact expectation amendments in the existing tests:

- First existing `resolves GitHub desktop publish config from Effect config`: both env blocks add `T3CODE_DESKTOP_UPDATE_FEED_ENABLED: "true"`; explicit/ambient repository strings become `goat-si/goat`; expected owner `goat-si`, repo `goat` in both objects.
- Existing preview test provider layer becomes `{ GITHUB_REPOSITORY: "goat-si/goat", T3CODE_DESKTOP_UPDATE_FEED_ENABLED: "true" }`; the stable release expected owner/repo become `goat-si`/`goat`.
- `derives macOS passkey signing configuration...` default app ID and `normalizes explicit...` application entitlement expectation become `si.goat.desktop`. Keep synthetic `com.t3tools.t3code` objects in entitlement authorization tests if they explicitly pass their own app ID: those tests prove parameterization, not GOAT defaults.
- `adds passkey entitlements...`: expected `config.appId` becomes `si.goat.desktop`; protocol display name becomes GOAT, schemes unchanged.
- Existing `resolveBuildOptions` default-options case asserts `resolved.macPasskeys === false`; add a second invocation with `T3CODE_DESKTOP_MAC_PASSKEYS: "true"`, `T3CODE_DESKTOP_SIGNED: "true"` and assert both booleans. Reuse the existing options literal; no new required `BuildCliInput` field was added.
- Signed nightly with explicit provisioning: render the resolved configuration and assert `<string>ABC1234567.si.goat.desktop.nightly</string>` and the authorized keychain group uses that ID, never the stable ID. Non-opted-in stage omits `t3codeWebAuthn`; verify the staged package in wp5 as well.

### Desktop profile and visible/runtime identity tests

Replace `DesktopUserData.test.ts` entirely with the following (the original tests assert removed upstream migration behavior). This is an explicit MODIFY, not deleting upstream files on disk.

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["darwin", "linux", "win32"] as const)(
  "isolates GOAT channels without importing upstream profiles on %s",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-profile-" });
      for (const name of ["t3code-v2", "t3code", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
        yield* fs.makeDirectory(path.join(root, name, "IndexedDB"), { recursive: true });
        yield* fs.writeFileString(path.join(root, name, "Local State"), "upstream keys");
        yield* fs.writeFileString(path.join(root, name, "IndexedDB", "LOCK"), "upstream database");
      }
      for (const [version, development, profile] of [
        ["1.2.3", false, "goat-desktop"],
        ["1.2.3-nightly.20261011.1", false, "goat-desktop-nightly"],
        ["1.2.3", true, "goat-desktop-dev"],
      ] as const) {
        const actual = yield* resolveUserDataPath({
          appDataDirectory: root,
          isDevelopment: development,
          platform,
          appVersion: version,
        });
        assert.equal(actual, path.join(root, profile));
        assert.isFalse(yield* fs.exists(path.join(actual, "Local State")));
        yield* fs.makeDirectory(actual, { recursive: true });
        yield* fs.writeFileString(path.join(actual, "Local State"), profile);
        assert.equal(
          yield* resolveUserDataPath({
            appDataDirectory: root,
            isDevelopment: development,
            platform,
            appVersion: version,
          }),
          actual,
        );
        assert.equal(yield* fs.readFileString(path.join(actual, "Local State")), profile);
      }
      for (const name of ["t3code-v2", "t3code", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
        assert.equal(
          yield* fs.readFileString(path.join(root, name, "Local State")),
          "upstream keys",
        );
        assert.equal(
          yield* fs.readFileString(path.join(root, name, "IndexedDB", "LOCK")),
          "upstream database",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
```

For existing desktop tests, amend the exact behavior cases as follows; preserve commit-hash, icon and error tests unrelated to removed profile probing:

| Test owner                                         | Before                                      | After / observable proof                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DesktopEnvironment.test.ts` development ID        | `com.t3tools.t3code.dev`                    | `si.goat.desktop.dev`; test overrides remain unchanged                                                                                                                                                                            |
| same file implicit production desktop home         | `/Users/alice/.t3/userdata`                 | `/Users/alice/.goat/desktop/userdata`; development stays `.t3/dev`                                                                                                                                                                |
| same file                                          | no stable/nightly identity comparison       | construct stable, nightly, dev; assert GOAT / GOAT (Nightly) / GOAT (Dev), correct Windows app IDs and override wins                                                                                                              |
| `DesktopAppIdentity.test.ts` V2 path               | `.../t3code-v2`                             | `.../goat-desktop`, even with upstream profiles present                                                                                                                                                                           |
| same file legacy dev path                          | `.../T3 Code (Dev)`                         | `.../goat-desktop-dev`; replace the removed inspect-failure test with nightly path isolation                                                                                                                                      |
| same file applicationName                          | `goat (Alpha)`                              | `GOAT`; nightly/dev labels uppercase GOAT; keep exact `setName` `T3 Code Alpha/Nightly/Dev` tests                                                                                                                                 |
| `DesktopClerk.test.ts` paths/event ordering        | `t3code-v2`, `t3code-dev`                   | `goat-desktop`, `goat-desktop-dev`; add nightly case `goat-desktop-nightly`; event sequence still `setPath:userData:<selected>`, then `createClerkBridge`                                                                         |
| `DesktopPreReadyFileSystem.test.ts` migration test | reads old Local State and creates t3code-v2 | add `appVersion: "1.2.3"` to helper; resolve `goat-desktop` synchronously, assert no destination Local State and old source keys untouched; remove unreadable-old-profile failure test because old profile is no longer inspected |
| NEW `DesktopLegacyLocalStorage.test.ts`            | file absent                                 | GOAT case: `load` + `take` yields none, source filesystem is never probed, and `complete` does not write an import marker                                                                                                         |

Required direct-call completeness gate: `rg -n 'resolveUserDataPath\(' apps/desktop/src`. Every direct literal caller must add `appVersion`; `environment` callers already contain it. Before applying the profile patch, inspect all current test helpers; do not add optional default appVersion just to silence missed callers.

Concrete identity-test hunks (common to both copy/fresh choices, including production-home expectations):

```patch
*** Begin Patch
*** Update File: apps/desktop/src/app/DesktopEnvironment.test.ts
@@
-      assert.equal(environment.appUserModelId, "com.t3tools.t3code.dev");
+      assert.equal(environment.appUserModelId, "si.goat.desktop.dev");
@@
 describe("DesktopEnvironment", () => {
+  it.effect("separates visible stable, nightly and development identities", () =>
+    Effect.gen(function* () {
+      const stable = yield* makeEnvironment({ isPackaged: true, appVersion: "1.2.3" });
+      const nightly = yield* makeEnvironment({ isPackaged: true, appVersion: "1.2.3-nightly.20261011.1" });
+      const dev = yield* makeEnvironment({}, { VITE_DEV_SERVER_URL: "http://localhost:5173" });
+      assert.equal(stable.displayName, "GOAT");
+      assert.equal(nightly.displayName, "GOAT (Nightly)");
+      assert.equal(dev.displayName, "GOAT (Dev)");
+      assert.equal(stable.appUserModelId, "si.goat.desktop");
+      assert.equal(nightly.appUserModelId, "si.goat.desktop.nightly");
+      assert.equal(dev.appUserModelId, "si.goat.desktop.dev");
+    }),
+  );
*** Update File: apps/desktop/src/app/DesktopAppIdentity.test.ts
@@
-import * as DesktopUserData from "./DesktopUserData.ts";
@@
-        assert.equal(userDataPath, "/Users/alice/Library/Application Support/t3code-v2");
+        assert.equal(userDataPath, "/Users/alice/Library/Application Support/goat-desktop");
@@
-  it.effect("keeps using the legacy development profile", () =>
+  it.effect("uses a GOAT development profile even when the upstream development profile exists", () =>
@@
-          "/Users/alice/Library/Application Support/T3 Code (Dev)",
+          "/Users/alice/Library/Application Support/goat-desktop-dev",
@@
-  it.effect("preserves failures while inspecting the legacy userData path", () => {
-    const legacyPath = "/Users/alice/Library/Application Support/T3 Code (Dev)";
-    const cause = PlatformError.systemError({
-      _tag: "PermissionDenied",
-      module: "FileSystem",
-      method: "exists",
-      description: "permission denied",
-      pathOrDescriptor: legacyPath,
-    });
-
-    return withIdentity(
-      Effect.gen(function* () {
-        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
-        const error = yield* identity.resolveUserDataPath.pipe(Effect.flip);
-
-        assert.instanceOf(error, DesktopUserData.DesktopUserDataInitializationError);
-        assert.equal(error.resourcePath, legacyPath);
-        assert.strictEqual(error.cause, cause);
-        assert.equal(
-          error.message,
-          `Could not initialize Electron user data during inspect at ${legacyPath} (PermissionDenied).`,
-        );
-      }),
-      {
-        legacyPathProbeError: cause,
-        environment: { env: { VITE_DEV_SERVER_URL: "http://localhost:5173" } },
-      },
-    );
-  });
+  it.effect("isolates a nightly profile without probing unreadable upstream profiles", () =>
+    withIdentity(
+      Effect.gen(function* () {
+        const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
+        assert.equal(yield* identity.resolveUserDataPath, "/Users/alice/Library/Application Support/goat-desktop-nightly");
+      }),
+      { environment: { appVersion: "1.2.3-nightly.20261011.1" } },
+    ),
+  );
@@
-        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, "goat (Alpha)");
+        assert.equal(calls.setAboutPanelOptions[0]?.applicationName, "GOAT");
*** Update File: apps/desktop/src/app/DesktopClerk.test.ts
@@
-      assert.deepEqual(events, ["setPath:userData:/tmp/app-data/t3code-dev", "createClerkBridge"]);
+      assert.deepEqual(events, ["setPath:userData:/tmp/app-data/goat-desktop-dev", "createClerkBridge"]);
@@
-      userData: "/tmp/app-data/t3code-v2",
+      userData: "/tmp/app-data/goat-desktop",
@@
-      userData: "/tmp/app-data/t3code-dev",
+      userData: "/tmp/app-data/goat-desktop-dev",
*** End Patch
```

The removed AppIdentity failure fixture's `PlatformError` type remains used by its optional legacy probe helper; it can be removed together with that now-unused probe plumbing as cleanup, but do not delete its FileSystem metadata fixture. If a real filesystem is denied for GOAT's own profile creation later, that failure belongs to the caller creating the profile, not the pure path resolver.

For both copy/fresh choices:

```patch
*** Begin Patch
*** Update File: apps/desktop/src/app/DesktopEnvironment.test.ts
@@
-      assert.equal(production.stateDir, "/Users/alice/.t3/userdata");
+      assert.equal(production.baseDir, "/Users/alice/.goat/desktop");
+      assert.equal(production.stateDir, "/Users/alice/.goat/desktop/userdata");
*** End Patch
```

Replace `apps/desktop/src/app/DesktopPreReadyFileSystem.test.ts` with this complete common test body. The original two cases tested upstream migration that no longer runs; this case retains synchronous-adapter proof using an actual file without requiring a profile read:

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopUserData from "./DesktopUserData.ts";

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("resolves GOAT profiles synchronously and leaves old Windows keys untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-pre-ready-" });
      const old = path.join(root, "T3 Code (Alpha)", "Local State");
      yield* fs.makeDirectory(path.dirname(old), { recursive: true });
      yield* fs.writeFileString(old, "upstream keys");
      const synchronous = yield* Effect.context<Path.Path>();
      const actual = Effect.runSync(
        DesktopUserData.resolveUserDataPath({
          appDataDirectory: root,
          isDevelopment: false,
          platform: "win32",
          appVersion: "1.2.3",
        }).pipe(Effect.provide(synchronous), Effect.provide(DesktopPreReadyFileSystem.layer)),
      );
      assert.equal(actual, path.join(root, "goat-desktop"));
      assert.isFalse(yield* fs.exists(path.join(actual, "Local State")));
      assert.equal(
        Effect.runSync(DesktopPreReadyFileSystem.make.readFileString(old)),
        "upstream keys",
      );
      assert.equal(yield* fs.readFileString(old), "upstream keys");
    }),
  );
});
```

### Home and bootstrap tests — fixed defaults for copy/fresh

Add `resolveBaseDir` to the existing import from `./os-jank.ts` and append these real temp-home cases. This does not mutate process HOME or open the real user's `.t3`.

```patch
*** Begin Patch
*** Update File: apps/server/src/os-jank.test.ts
@@
-import { fixPath, hydratePosixHome } from "./os-jank.ts";
+import { fixPath, hydratePosixHome, resolveBaseDir } from "./os-jank.ts";
+import * as FileSystem from "effect/FileSystem";
+import * as Path from "effect/Path";
@@
 vi.mock("node:child_process", { spy: true });
+
+effectIt.effect("resolves a fresh GOAT home while preserving explicit upstream and custom homes", () =>
+  Effect.gen(function* () {
+    const fs = yield* FileSystem.FileSystem;
+    const path = yield* Path.Path;
+    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-base-" });
+    yield* fs.makeDirectory(path.join(home, ".t3", "userdata"), { recursive: true });
+    const sentinel = path.join(home, ".t3", "userdata", "settings.json");
+    yield* fs.writeFileString(sentinel, "upstream sentinel");
+    for (const raw of [undefined, "", " "]) {
+      assert.equal(yield* resolveBaseDir(raw).pipe(Effect.provideService(HostProcess.HomeDirectory, home)), path.join(home, ".goat"));
+    }
+    assert.equal(yield* resolveBaseDir("~/.t3").pipe(Effect.provideService(HostProcess.HomeDirectory, home)), path.join(home, ".t3"));
+    assert.equal(yield* resolveBaseDir(path.join(home, "chosen")), path.join(home, "chosen"));
+    assert.equal(yield* fs.readFileString(sentinel), "upstream sentinel");
+    assert.isFalse(yield* fs.exists(path.join(home, ".goat")));
+  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
+);
*** End Patch
```

`DesktopEarlyElectronStartup.test.ts`: add a production/no-home case with a settings reader recording the path, returning `{ "linuxPasswordStore": "kwallet6" }`; assert `<temp or fixture home>/.goat/desktop/userdata/desktop-settings.json` was read and the existing normalization returns `kwallet6`. Existing explicit `T3CODE_HOME=/home/user/.t3-test` and implicit dev `.t3/dev` tests stay unchanged. Add blank home string production case to ensure trimming agrees with `DesktopConfig`.

`apps/server/src/cli/config.test.ts`: separate generic fallback from actual desktop bootstrap. The existing minimal desktop-mode flags without a bootstrap still resolve the generic `<home>/.goat` default; this is not proof of packaged desktop home selection. With `baseDir: Option.none()`, `cwd: Option.some(temp home)`, empty env and `HostProcess.HomeDirectory` provided as temp home, assert generic `baseDir=<home>/.goat`, `stateDir=<home>/.goat/userdata`, and derived DB path; keep upstream sentinel bytes unchanged. Add a second case using existing `openBootstrapFd` with `t3Home=<home>/.goat/desktop`, then assert resolved `baseDir=<home>/.goat/desktop`, `stateDir=<home>/.goat/desktop/userdata`, and `dbPath=<home>/.goat/desktop/userdata/statev2.sqlite`. Cover flag custom > env custom > bootstrap desktop home > generic default; blank env falls through to the desktop bootstrap.

`DesktopBackendConfiguration.test.ts`: its current helper explicitly supplies `T3CODE_HOME=baseDir`, so the existing `bootstrap.t3Home === environment.baseDir` assertion proves only explicit-home propagation. Add a packaged-production case with no home override (allow the fixture helper to omit `T3CODE_HOME`), injected isolated home, and assert environment base `.goat/desktop` and the actual primary bootstrap `t3Home` equal that full path. Retain explicit custom-home and worktree cases. Together with the server bootstrap case, this proves the complete desktop-to-server path rather than a mode flag alone. Preserve the landed primary bundled-resource env assertion and WSL bundled-path translation/WSLENV cases; a new default home must not redirect the read-only bundle into the mutable home cache.

`apps/server/src/cli/browser.test.ts` is NEW. Export the existing `setupBaseDir` function without changing its behavior/API over the wire; test the actual resolver with fake `getent` output and an isolated real filesystem, explicit home and T3CODE_HOME precedence. The complete patch below avoids invoking apt/sudo/browser. This tests resolved directory behavior, including the special sudo source of the home, rather than a second implementation of its string concatenation.

`scripts/dev-runner.test.ts` and `packages/shared/src/devHome.test.ts` remain unchanged regression suites: linked worktree `.t3` must still outrank ambient home, explicit `--home-dir` wins, no baked origins. Run them once, no repository-wide suite.

Concrete NEW test files and home cases follow. These were verified as absent/new or against the exact existing import/describe anchors, respectively. Apply these pieces for both copy/fresh choices; only actual operator import execution is conditional. `setupBaseDir` is the actual browser setup home resolver; exporting it is only a module/test seam, not a new RPC or shell command.

```patch
*** Begin Patch
*** Update File: apps/server/src/cli/browser.ts
@@
-const setupBaseDir = Effect.fn("browserSetup.baseDir")(function* (explicit: Option.Option<string>) {
+export const setupBaseDir = Effect.fn("browserSetup.baseDir")(function* (explicit: Option.Option<string>) {
*** Add File: apps/server/src/cli/browser.test.ts
+import * as NodeServices from "@effect/platform-node/NodeServices";
+import { assert, it } from "@effect/vitest";
+import * as HostProcess from "@t3tools/shared/HostProcess";
+import * as Effect from "effect/Effect";
+import * as FileSystem from "effect/FileSystem";
+import * as Option from "effect/Option";
+import * as Path from "effect/Path";
+import { ChildProcess, ChildProcessSpawner } from "effect/process";
+import { setupBaseDir } from "./browser.ts";
+
+it.effect("sudo browser setup resolves the invoking user's home and respects explicit overrides", () =>
+  Effect.gen(function* () {
+    const fs = yield* FileSystem.FileSystem;
+    const path = yield* Path.Path;
+    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-browser-home-" });
+    const userHome = path.join(root, "alice");
+    const old = path.join(userHome, ".t3", "tools", "sentinel");
+    yield* fs.makeDirectory(path.dirname(old), { recursive: true });
+    yield* fs.writeFileString(old, "upstream browser data");
+    const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
+    let getentCalls = 0;
+    const spawner = ChildProcessSpawner.make((command) => {
+      assert.equal(command._tag, "StandardCommand");
+      if (command._tag !== "StandardCommand") return Effect.die("unexpected pipe");
+      assert.equal(command.command, "getent");
+      assert.deepEqual(command.args, ["passwd", "alice"]);
+      getentCalls++;
+      return realSpawner.spawn(ChildProcess.make(process.execPath, ["-e", "process.stdout.write(process.argv[1])", `alice:x:1000:1000::${userHome}:/bin/sh\n`]));
+    });
+    const resolve = (explicit: Option.Option<string>, env: NodeJS.ProcessEnv) =>
+      setupBaseDir(explicit).pipe(
+        Effect.provideService(HostProcess.Environment, env),
+        Effect.provideService(HostProcess.HomeDirectory, path.join(root, "root")),
+        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
+      );
+    const selected = yield* resolve(Option.none(), { SUDO_USER: "alice" });
+    assert.equal(selected, path.join(userHome, ".goat"));
+    yield* fs.makeDirectory(path.join(selected, "tools"), { recursive: true });
+    yield* fs.writeFileString(path.join(selected, "tools", "sentinel"), "GOAT browser data");
+    assert.equal(yield* resolve(Option.some(path.join(root, "explicit")), { SUDO_USER: "alice", T3CODE_HOME: path.join(root, "env") }), path.join(root, "explicit"));
+    assert.equal(yield* resolve(Option.none(), { SUDO_USER: "alice", T3CODE_HOME: path.join(root, "env") }), path.join(root, "env"));
+    assert.equal(getentCalls, 1);
+    assert.equal(yield* fs.readFileString(old), "upstream browser data");
+  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
+);
*** Add File: apps/desktop/src/app/DesktopLegacyLocalStorage.test.ts
+import * as NodeServices from "@effect/platform-node/NodeServices";
+import { assert, it } from "@effect/vitest";
+import * as Effect from "effect/Effect";
+import * as FileSystem from "effect/FileSystem";
+import * as Layer from "effect/Layer";
+import * as Option from "effect/Option";
+import { vi } from "vite-plus/test";
+import * as DesktopConfig from "./DesktopConfig.ts";
+import * as DesktopEnvironment from "./DesktopEnvironment.ts";
+import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
+
+vi.mock("electron", () => ({}));
+
+it.effect("a GOAT profile never imports or marks upstream V1 Local Storage", () =>
+  Effect.gen(function* () {
+    const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(
+      DesktopEnvironment.layer({ dirname: "/repo/apps/desktop/dist-electron", homeDirectory: "/isolated", platform: "darwin", processArch: "arm64", appVersion: "1.2.3", appPath: "/install/app.asar", isPackaged: true, resourcesPath: "/install", runningUnderArm64Translation: false }).pipe(
+        Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
+      ),
+    ));
+    const unexpected = () => Effect.die("GOAT must not probe/write upstream profile migration state");
+    const service = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage.pipe(Effect.provide(
+      DesktopLegacyLocalStorage.layer.pipe(
+        Layer.provide(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
+        Layer.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({ exists: unexpected, readDirectory: unexpected, readFileString: unexpected, writeFileString: unexpected })))),
+      ),
+    ));
+    yield* service.load("/isolated/profiles/goat-desktop");
+    assert.isTrue(Option.isNone(yield* service.take));
+    yield* service.complete;
+    assert.isTrue(Option.isNone(yield* service.take));
+  }).pipe(Effect.scoped),
+);
*** Update File: apps/desktop/src/app/DesktopEarlyElectronStartup.test.ts
@@
 describe("DesktopEarlyElectronStartup", () => {
   const joinPath = NodePath.posix.join;
+
+  it("reads production password-store preferences from the GOAT home including a blank override", () => {
+    for (const env of [{}, { T3CODE_HOME: " " }]) {
+      const observed: string[] = [];
+      const preference = resolveEarlyLinuxPasswordStorePreference({
+        env, homeDirectory: "/home/alice", joinPath,
+        readFileString: (path) => { observed.push(path); return JSON.stringify({ linuxPasswordStore: "kwallet6" }); },
+      });
+      assert.deepEqual(observed, ["/home/alice/.goat/desktop/userdata/desktop-settings.json"]);
+      assert.equal(preference, "kwallet6");
+    }
+  });
*** Update File: apps/server/src/cli/config.test.ts
@@
 import * as NetService from "@t3tools/shared/Net";
+import * as HostProcess from "@t3tools/shared/HostProcess";
@@
 it.layer(NodeServices.layer)("cli config resolution", (it) => {
+  it.effect("keeps the generic server default at GOAT home without a desktop bootstrap", () =>
+    Effect.gen(function* () {
+      const fs = yield* FileSystem.FileSystem;
+      const path = yield* Path.Path;
+      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-default-config-" });
+      const old = path.join(home, ".t3", "userdata", "settings.json");
+      yield* fs.makeDirectory(path.dirname(old), { recursive: true });
+      yield* fs.writeFileString(old, "upstream settings sentinel");
+      const config = yield* resolveServerConfig({ ...minimalDesktopFlags(home), baseDir: Option.none(), cwd: Option.some(home) }, Option.none()).pipe(
+        Effect.provideService(HostProcess.HomeDirectory, home),
+        Effect.provide(NetService.layer),
+        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
+      );
+      assert.equal(config.baseDir, path.join(home, ".goat"));
+      assert.equal(config.stateDir, path.join(home, ".goat", "userdata"));
+      assert.equal(config.dbPath, path.join(home, ".goat", "userdata", "statev2.sqlite"));
+      assert.equal(yield* fs.readFileString(old), "upstream settings sentinel");
+    }).pipe(Effect.scoped),
+  );
*** End Patch
```

The `cli/config` fixture uses the complete owning `NetService.layer`; its explicit desktop port avoids port-discovery work. The browser test redirects only `getent` to a harmless real Node child; no apt, sudo, native browser or actual root environment is used. A Windows CI run can run the resolver because no actual getent is invoked.

### Real shell SSH regression: no remote-home crossover

wp3 does not modify generated SSH scripts. Nevertheless keep an observable regression in `packages/ssh/src/tunnel.test.ts` proving desktop home/profile changes cannot redirect a GOAT remote runner into upstream `.t3`. Add inside its existing `describe("archive runner script", ...)`, after `runShell` is in scope. Use `nativeScripts` to obtain actual native Node-generated runner bytes, not a manually reconstructed command. The test has a ready fake executable, avoiding network/downloads/locks, and runs `/bin/sh` with isolated HOME through the existing real-shell helper.

```patch
*** Begin Patch
*** Update File: packages/ssh/src/tunnel.test.ts
@@
   const runRunner = (home: string, runner: string) => runShell(home, [runner, "--version"]);
   const runUpload = (home: string, script: string, bytes: Uint8Array) =>
     runShell(home, ["-c", script], bytes);
+
+  it.effect.skipIf(windowsHost)("keeps a retained GOAT runner off upstream data despite an ambient T3 home", () =>
+    Effect.gen(function* () {
+      const fs = yield* FileSystem.FileSystem;
+      const path = yield* Path.Path;
+      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-identity-shell-" });
+      const old = path.join(home, ".t3", "userdata");
+      yield* fs.makeDirectory(old, { recursive: true });
+      const sentinel = path.join(old, "settings.json");
+      yield* fs.writeFileString(sentinel, "upstream remains intact");
+      const runtime = path.join(home, ".goat", "runtime", "goat", "versions", archiveVersion);
+      yield* fs.makeDirectory(runtime, { recursive: true });
+      yield* fs.writeFileString(path.join(runtime, "goat"), "#!/bin/sh\nprintf 'goat-ready\\n'\n");
+      yield* fs.chmod(path.join(runtime, "goat"), 0o700);
+      yield* fs.writeFileString(path.join(runtime, ".install-complete"), archiveVersion);
+      const scripts = yield* nativeScripts({ archiveVersion });
+      const runner = path.join(home, "runner.sh");
+      yield* fs.writeFileString(runner, scripts.runner);
+      const result = yield* runShell(home, ["-c", 'export T3CODE_HOME="$HOME/.t3"; exec sh "$1" --version', "identity", runner]);
+      assert.equal(result.exitCode, 0, result.stderr);
+      assert.equal(result.stdout, "goat-ready\n");
+      assert.equal(yield* fs.readFileString(sentinel), "upstream remains intact");
+      assert.isFalse(yield* fs.exists(path.join(home, ".t3", "runtime")));
+      assert.isFalse(yield* fs.exists(path.join(home, ".t3", "ssh-launch")));
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );
*** End Patch
```

The insertion now follows the current `runShell`/`runRunner`/`runUpload` definitions. At `480ed90da`, `nativeScripts` accepts `SshTunnel.RemoteT3RunnerOptions`, returns `.runner`, and the field is still `archiveVersion`; the Windows skip and isolated-HOME shell helper remain available. Both landed install-before-switch and bundled-acquisition tests stay intact. This case proves retained-runtime location and preservation; D1/D2/D4 own launch, pairing, failure/switch and protocol cases. Do not duplicate their tests or weaken their frozen-byte gate.

### Frozen fixture disposition

`packages/ssh/src/fixtures/remote-runner-baseline.json`: **no update in wp3**. Explicit entry list:

- `archive.runner`, `archive.launch`, `archive.pairing`: unchanged.
- `mirror.runner`, `mirror.launch`, `mirror.pairing`: unchanged.
- `node.runner`, `node.launch`, `node.pairing`: unchanged.

wp1/wp2 have landed at the stale-check HEAD; wp3 keeps the current bytes identified by the SHA256 in Source grounding. No regeneration from failing output, no global rename inside fixture. A wp3-only fixture diff is a scope defect; report it to parent. Source leaves have no git authority; parent records exact fixture byte-diff evidence.

## Acceptance and activation matrix

| Scenario                                                                             | Observable result                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| local signed/unsigned, absent feed opt-in, canonical/upstream ambient repo           | config contains `publish: null`; actual local package later has no `app-update.yml` or update manifests; no upstream polling                                                                        |
| feed enabled + explicit canonical or canonical ambient                               | GitHub GOAT latest/nightly config; no actual release upload                                                                                                                                         |
| enabled + explicit invalid while ambient canonical                                   | null publish; invalid override cannot switch to another repository                                                                                                                                  |
| preview/PR + feed enabled/mock                                                       | null publish, no app update metadata                                                                                                                                                                |
| mock non-preview + any canonical feed env                                            | generic local mock URL wins                                                                                                                                                                         |
| stable/nightly product                                                               | GOAT / GOAT (Nightly), GOAT prefix, stable/nightly own bundle IDs                                                                                                                                   |
| unsigned, or signed without passkey opt-in and missing profile vars                  | signing plan does not require profile; no entitlement-specific WebAuthn metadata                                                                                                                    |
| signed mac + passkey opt-in, bad/missing team/profile/domain                         | existing typed build error; no silent half-provisioned app                                                                                                                                          |
| entitled signed nightly                                                              | correct nightly app ID in signed entitlement fields and metadata                                                                                                                                    |
| old upstream profiles present                                                        | GOAT stable/nightly/dev paths remain distinct; upstream files unchanged; no automatic Windows Local State/V1 import                                                                                 |
| About/menu identity                                                                  | visible GOAT names; runtime setName remains T3 Code Alpha/Nightly/Dev                                                                                                                               |
| no override, packaged desktop environment + primary bootstrap + early Linux settings | `.goat/desktop` base and `.goat/desktop/userdata` state/settings through actual inputs; upstream `.t3` untouched                                                                                    |
| standalone CLI + SSH-host default + sudo browser fallback                            | `.goat` base and `.goat/userdata` state; no `/desktop` suffix                                                                                                                                       |
| explicit home + dev linked worktree                                                  | custom paths unchanged; worktree `.t3` isolation and precedence retained                                                                                                                            |
| sudo browser setup                                                                   | invoking user's `.goat` browser installation inspected                                                                                                                                              |
| D9-A rehearsal                                                                       | stopped projects/thread families retained without dev sample caps; runnable/auth tables empty; WAL/integrity/source preservation pass; existing/racing DB refused; no secrets/settings/runtime copy |
| D9-A operator gate                                                                   | manual `node scripts/import-desktop-home.ts --from <dir>` executes in wp5 only after user chooses copy                                                                                              |
| D9-B                                                                                 | no import; fresh `.goat/desktop/userdata` created only by normal desktop startup                                                                                                                    |
| native shell with isolated HOME / retained ready runtime                             | executes `.goat` runtime, no `.t3` runtime writes; frozen script entries unchanged                                                                                                                  |

Surfaces: desktop packaging and Electron startup are in scope; hosted/local web and mobile display/provider behavior are unchanged. Standalone/remote GOAT CLI defaults stay `.goat`; desktop alone defaults to `.goat/desktop`. Explicit homes/protocol remain authoritative. All provider adapters use the same server home and need no adapter changes. Existing updater UI/service reports unavailable when no `app-update.yml`; use its focused regression suite. The only new operator entry is the manually invoked import script; no new UI action, RPC method or scheduler path is added.

### Filtered import tests

Add `scripts/import-desktop-home.test.ts` using real temporary databases and the server migration fixture patterns described in D9-A. Export an operation with injected test home, and keep argument parsing/Node entry thin. Test the manual `--from` validation plus observable snapshot filtering, all-project/stopped-family retention, no automatic files, WAL preservation, source hashes, absent-target-only publication and failure/race/repeat cases. Reuse the existing migration runner; its dev rebuild tests remain unchanged and run as a regression. Parent must confirm the repository’s Node TypeScript/workspace resolution supports the exact operator command and the cross-package script import, and account for the scripts composite tsconfig boundary without duplicating filtering logic. Run an isolated invocation of the exact command in wp5 before any selected real-home import; do not replace it with a loader-only test that would leave the advertised command unproven.

## Exact focused verification commands (parent executor only)

Start each fenced group from `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename`. These are proposed commands, all NOT RUN by this leaf. Config/path grounding: root `vite.config.ts` defines Node tests/excludes `.t3` and build output; scripts' own package test command explicitly uses `--config ../vite.config.ts --dir .`; desktop/server/ssh paths below are direct file arguments. TypeScript configs include source (`apps/desktop/tsconfig.json` includes src/vite config/scripts lib; server includes src/integration/scripts; scripts includes `**/*.ts`). Parent checks dependency presence instead of installing/building from this leaf.

```sh
cd scripts && ../node_modules/.bin/vp test run --config ../vite.config.ts --dir . build-desktop-artifact.test.ts dev-runner.test.ts import-desktop-home.test.ts
```

```sh
cd apps/desktop && ../../node_modules/.bin/vp test run --config ../../vite.config.ts --dir . src/app/DesktopEnvironment.test.ts src/app/DesktopAppIdentity.test.ts src/app/DesktopUserData.test.ts src/app/DesktopPreReadyFileSystem.test.ts src/app/DesktopClerk.test.ts src/app/DesktopLegacyLocalStorage.test.ts src/updates/DesktopUpdates.test.ts src/preview/Passkeys.test.ts
```

For both D9 copy/fresh choices include:

```sh
cd apps/desktop && ../../node_modules/.bin/vp test run --config ../../vite.config.ts --dir . src/app/DesktopEarlyElectronStartup.test.ts src/backend/DesktopBackendConfiguration.test.ts
```

```sh
cd apps/server && ../../node_modules/.bin/vp test run --config ../../vite.config.ts --dir . src/os-jank.test.ts src/cli/config.test.ts src/cli/browser.test.ts scripts/migrate-dev-db.test.ts
```

```sh
cd packages/shared && ../../node_modules/.bin/vp test run --config ../../vite.config.ts --dir . src/devHome.test.ts
```

```sh
cd packages/ssh && ../../node_modules/.bin/vp test run --config ../../vite.config.ts --dir . src/tunnel.test.ts
```

From the source lane root, run each independently:

```sh
./node_modules/.bin/vp exec tsc -p scripts/tsconfig.json --noEmit
./node_modules/.bin/vp exec tsc -p apps/desktop/tsconfig.json --noEmit
./node_modules/.bin/vp exec tsc -p apps/server/tsconfig.json --noEmit
./node_modules/.bin/vp exec tsc -p packages/ssh/tsconfig.json --noEmit
```

Typecheck covers entire owning package, not repo-wide recursion. The scripts/desktop configs are composite; parent should account for any tsbuildinfo writes in its executor scope. Do not use `vp check`, recursive tests/typecheck, packaging as a substitute for focused proof, or launch native clients from this leaf. Source inspection/textual matching in this stale check did not execute any of these verifiers.

Read-only rg gates from source root; rg returns 1 for no matches (expected for a negative gate), so record findings rather than mislabeling exit 1 as test failure:

```sh
rg -n 'T3CODE_DESKTOP_UPDATE_FEED_ENABLED|DESKTOP_UPDATE_REPOSITORY|publish: null|resolveGitHubPublishConfig' scripts/build-desktop-artifact.ts
rg -n 'T3-Code-\$\{version\}|const DESKTOP_APP_ID = "com\.t3tools' scripts/build-desktop-artifact.ts
rg -n 'T3CODE_DESKTOP_MAC_PASSKEYS|macPasskeys|resolveOptionalMacPasskeySigningConfiguration|t3codeWebAuthn' scripts/build-desktop-artifact.ts
rg -n 'DESKTOP_RUNTIME_APP_BASE_NAME|setName\(|stageLabel|displayName|appUserModelId' apps/desktop/src/app/DesktopEnvironment.ts apps/desktop/src/app/DesktopAppIdentity.ts
rg -n 'resolveUserDataPath\(|goat-desktop|t3code-v2|legacyState|sourceState' apps/desktop/src/app/DesktopUserData.ts apps/desktop/src/app/DesktopClerk.ts apps/desktop/src/app/DesktopAppIdentity.ts
rg -n 'resolveDesktopBaseDir\(|"\.t3"|"\.goat"' apps/desktop/src/app/DesktopStatePaths.ts apps/desktop/src/app/DesktopEnvironment.ts apps/desktop/src/app/DesktopEarlyElectronStartup.ts apps/server/src/os-jank.ts apps/server/src/cli/browser.ts
rg -n 'resolveWorktreeT3Home|\.t3|home-dir' packages/shared/src/devHome.ts scripts/dev-runner.ts
rg -n 'HOME/\.t3|"\.t3"|~/\.t3' apps/desktop/src apps/server/src --glob '!*.test.ts'
```

Expected findings: first/third gates show explicit opt-in creation/consumption; second has no hits. Runtime base remains T3 Code. Own profile source contains no upstream legacy reads. Desktop path gates show production `.goat/desktop` and implicit development `.t3`; central server/sudo defaults show `.goat` without a desktop suffix. The broad final gate has intentional WSL runtime cache, legacy comments, capture temporary filenames, dev/home compatibility references and explicit overrides; inspect each, do not bulk-replace. `cli/browser.ts` sudo home is no longer an unexplained `.t3` default for the generic CLI. Misleading informational `.t3` comments in the affected code may be updated with the owning change; no new feature catalog or implementation notes in shipped user docs.

## Risks, evidence limits and suggested 000 amendments

1. D3 should explicitly state the new feed opt-in variable, default false, canonical repo validation and literal `publish: null`. A valid repo alone does not mean private/unpublished release artifacts can be fetched by the updater. Future release workflow enabling is a separate authorized decision; wp2 must not accidentally enable it for all builds.
2. D3 should name profile folders `goat-desktop`, `goat-desktop-nightly`, `goat-desktop-dev`, and preserve runtime `T3 Code Alpha/Nightly/Dev`. Stable stage Alpha is an internal compatibility label; stable visible product is GOAT. Runtime-name retention is a preservation hypothesis to validate with native safeStorage, not a guarantee of credentials surviving new bundle/profile identity.
3. Audit blocker 4 fixes the packaged desktop production home to `~/.goat/desktop`; standalone CLI, SSH hosts and sudo browser fallback stay `~/.goat`. DesktopStatePaths, early Linux settings, environment and primary bootstrap tests must prove the distinction. Explicit home precedence, dev-runner worktree `.t3` and WSL distribution cache stay unchanged. The old D9-C shared-default option is superseded.
4. Audit blocker 5 requires D9-A to mean an explicit manual filtered snapshot import using `runMigrateDevDb`, not a whole-DB backup or settings/secrets copy. Keep stopped projects/thread families; drop scheduled tasks, pending commands/work, outbox effects and auth sessions. Publish only into an absent `~/.goat/desktop/userdata/statev2.sqlite`, preserving source and existing targets. `scripts/import-desktop-home.ts --from <dir>` is implemented now and run only in wp5 after the user chooses copy; fresh skips it. Remote upstream migration and automatic credential/profile import stay excluded.
5. D3 passkey opt-in should be separate from Developer ID signing: `T3CODE_DESKTOP_MAC_PASSKEYS`, default false. `--signed` alone must not require an Associated Domains profile; a provisioned nightly needs its own app ID. Local unsigned packaging remains buildable.
6. Current Linux executable/protocol/portal/WMClass/AppStream compatibility IDs are retained in this bounded plan; parent must either accept that limitation or explicitly add coordinated Linux OS-registration separation. OAuth URL schemes are similarly retained. This document does not claim simultaneous upstream/GOAT Linux default-browser registration is isolated.
7. The local feed's packaged absence and native launch/decryption still need wp5 proof. Tests of config generation, stage metadata or mocked Electron services cannot establish actual signing, Keychain permissions, Chromium profile portability, launch success or update polling behavior. Parent records exact selected D9, package evidence and independent final-head review before closing wp3/wp5.

Source-of-truth sync: update the D3/D9 rows in `000_plan.md` with accepted choices and relevant caveats, owned by parent. No source architecture/user doc is required just to restate these constants; update an existing documented home/signing setup only if parent finds an actual now-inaccurate instruction. This leaf does not amend `000_plan.md` or any source file.

## Reflection fold (A6) — audit blockers 4–5

Folded into the owning home patches, D9 copy/fresh operator sections, file map, tests and acceptance gates above. Packaged production desktop uses `~/.goat/desktop`; standalone/SSH defaults stay `~/.goat`; dev-worktree `.t3` is unchanged. The old whole-DB backup/copy block is removed. The explicit manual import reuses the migration runner in private staging and publishes only filtered projects/stopped history to an absent desktop DB, with source preservation and no automatic secrets/runtime/service transfer. Actual execution remains gated on the user’s copy/fresh choice in wp5.

## Audit fold (cycle 3)

1. Scope expansion approved: .github/workflows/release-desktop.yml (~574–587) prepares/requires the provisioning profile only when an explicit passkey opt-in input/env is true and passes that opt-in to the build; ordinary Developer ID signing and notarization stay unconditional for signed builds. Extend scripts/release-desktop-runtime.test.ts to cover signed mac with opt-in off (no profile requirement, signing still configured) and on (profile required, entitlements included).
2. Update feed: select the explicit override by presence (`!== undefined`), then validate; an empty/whitespace explicit value yields publish null and never falls back to ambient GITHUB_REPOSITORY. Tests for empty/whitespace overrides with canonical ambient.
3. CLI shim: DesktopCliShim.ts derives home from environment.baseDir (no resolver edit); add a test that a shim rendered for a packaged environment embeds ~/.goat/desktop, honours explicit overrides and leaves ~/.t3 untouched.
4. Import script lives at apps/server/scripts/import-desktop-home.ts (next to migrate-dev-db.ts, reusing its exported logic, same tsconfig); command `node apps/server/scripts/import-desktop-home.ts --from <dir> [--to ~/.goat/desktop]`; prove apps/server typecheck and a dry run against a scratch copy in tests.
