# Lane L1_signing (gpt-6.1-sol, read-only, 2026-10-12, base 32f7bda9b)

**The login-keychain signing and `goat-notary` design is supported by the installed dependencies, but the workflow currently disables signing unless certificate-export and API-key secrets exist.** Discovery was read-only. Read scope expanded to the custom signer, native-package handling, and installed builder sources; no files changed.

1. **Workflow and self-hosted runner**

- `.github/workflows/release-desktop.yml:38` accepts runner, platform, target, arch, Rust target, resource key, version, ref, channel, CLI/SSH/passkey switches, and Clerk/relay configuration. Secrets at `:12` include `CSC_LINK`, certificate password, and Apple API credentials; no keychain-profile input exists.
- `:112` uses `"runs-on: ${{ inputs.runner }}"`, a single string, not a runner-label matrix. Use a unique Mac Studio label, or change the interface to accept JSON labels and use `fromJSON`.
- `:134` runs `"git init ."` followed by unconditional `git remote add origin`; `:136` performs an unauthenticated fetch. This assumes a public repository and fresh workspace. A private repository needs authenticated checkout; persistent self-hosted workspaces also make `remote add` fail on subsequent runs. Prefer `actions/checkout` with the existing sparse exclusions and appropriate private-repository credentials.
- `:335` imports a P12 into `$RUNNER_TEMP/t3-cli-signing.keychain-db`; `:356` changes the user keychain search list. Missing export secrets cause an early return at `:343`, so an existing identity never becomes `T3CODE_CLI_MAC_SIGN_IDENTITY`.
- `:578` requires **all five** certificate/API credentials before `:596` adds `--signed`. Consequently, existing keychain credentials alone are insufficient.
- Hosted assumptions also include ephemeral certificate files/keychains without workflow cleanup, clean artifact directories, and toolchain availability. Vite+ setup/cache (`:146`), dependency metadata (`:155`), and Rust/cache setup (`:167`, `:184`) can remain, but the self-hosted machine needs the macOS prerequisites checked by `scripts/build-desktop-artifact.ts:1978`: Cargo/targets, clang, make, sips, iconutil, and lipo for universal.
- `release-desktop.yml:649` renames x64 mac manifests to `*-mac-x64.yml`; arm64 retains `*-mac.yml`. Windows receives `-win-<arch>` suffixes at `:661`.

**Recommended self-hosted environment:** `CSC_NAME` identifying the certificate **without** the `Developer ID Application:` prefix, `CSC_KEYCHAIN` pointing to the runner account’s login keychain, `CSC_IDENTITY_AUTO_DISCOVERY=true`, `APPLE_KEYCHAIN_PROFILE=goat-notary`, and `APPLE_KEYCHAIN` pointing to that same keychain. Set `T3CODE_CLI_MAC_SIGN_IDENTITY` to the full Developer ID identity and team `U9ATA49N28`; pass `--signed`. The runner account must already have usable, unlocked signing-key access.

2. **Desktop packaging, architecture, and installed notarization support**

- `scripts/build-desktop-artifact.ts:2842` generates builder configuration, written into staged `package.json` at `:4207`. Mac `"target: target === \"dmg\" ? [target, \"zip\"] : [target]"` is at `:2914`; architecture reaches electron-builder as `"--${options.arch}"` at `:4340`.
- Signed builds select `scripts/sign-macos.ts` at `:2946`. That hook delegates to `@electron/osx-sign` with `"batchCodesignCalls: true"` (`scripts/sign-macos.ts:5`).
- The generated mac config has **no explicit** `notarize` or `hardenedRuntime` property. Custom entitlements/provisioning apply only to passkey opt-in at `:2947`; rendered entitlements include JIT, unsigned executable memory, and disabled library validation at `:1464`.
- Installed versions are **electron-builder 26.15.6** (`node_modules/.pnpm/electron-builder@26.15.6_electron-builder-squirrel-windows@26.15.6/node_modules/electron-builder/package.json:4`) and **@electron/notarize 2.5.0** (`node_modules/.pnpm/@electron+notarize@2.5.0/node_modules/@electron/notarize/package.json:3`).
- Builder directly honors the login keychain: `node_modules/.pnpm/app-builder-lib@26.15.6_dmg-builder@26.15.6_electron-builder-squirrel-windows@26.15.6/node_modules/app-builder-lib/out/macPackager.js:49` returns `"keychainFile: process.env.CSC_KEYCHAIN || null"`.
- Its notarization implementation explicitly reads `APPLE_KEYCHAIN` and `APPLE_KEYCHAIN_PROFILE`: `node_modules/.pnpm/app-builder-lib@26.15.6_dmg-builder@26.15.6_electron-builder-squirrel-windows@26.15.6/node_modules/app-builder-lib/out/mac/MacTargetHelper.js:245`. Apple-ID and API-key modes precede profile mode (`:224`, `:239`), so remove stale competing credentials. Hardened runtime defaults on at `:177`; absent custom entitlements fall back to the builder template at `:156`. Missing notarization credentials only warn and skip at `:263`.
- `@electron/notarize` generates `"--keychain", opts.keychain, "--keychain-profile", opts.keychainProfile` at `node_modules/.pnpm/@electron+notarize@2.5.0/node_modules/@electron/notarize/lib/notarytool.js:75`, checks status `"Accepted"` at `:147`, and staples the app through `lib/index.js:47`.

**Native architecture handling:**

- Production staging runs `vp install --prod`, not `npm install --arch` (`build-desktop-artifact.ts:1004`, `:4227`). Target selection uses pnpm `supportedArchitectures`, with target OS/CPU at `:1667`.
- node-pty ships both Darwin prebuilds; `:1058` excludes the unused architecture. FFF packages explicitly select Darwin arch at `:1484`; Clerk passkeys and keyring select/stage arch-specific binaries at `:1548`, `:1571`, `:4235`.
- Mac leaves builder’s native rebuild enabled; only Windows sets `npmRebuild=false` (`:3037`). Builder passes target architecture into dependency rebuild at `node_modules/.pnpm/app-builder-lib@26.15.6_dmg-builder@26.15.6_electron-builder-squirrel-windows@26.15.6/node_modules/app-builder-lib/out/packager.js:476`.
- Rust helpers use explicit `aarch64-apple-darwin`/`x86_64-apple-darwin` targets (`build-desktop-artifact.ts:148`, `:2427`); universal combines binaries with lipo at `:2477`.
- SQLite uses Node’s built-in implementation (`apps/server/src/persistence/initializeV2Database.ts:1`, `"node:sqlite"`), rather than a separately rebuilt better-sqlite addon.
- Bundled SSH archives are exactly `darwin-arm64`, `linux-x64`, `linux-arm64` (`build-desktop-artifact.ts:3132`), independent of desktop arch. There is no Darwin x64 SSH archive.
- Mac uses one `app.asar` for desktop/server dependencies (`:1501`, `:4375`); native unpacking relies on builder defaults. Commit metadata resolves at `:3919` and is embedded as `"t3codeCommitHash: commitHash"` at `:4172`.
- **An arm64 Mac has a supported source path for an x64 DMG**, including target packages, Electron architecture, and Rust cross-compilation. This was not build-tested. Existing x64 CLI production is deliberately disabled because of the recorded SEA limitation (`.github/workflows/release.yml:591`).

3. **CLI signing/notarization**

- `scripts/build-cli-archive.ts:285` supports only identity plus API-key configuration.
- `:310` selects files by suffix: `.node`, `.dylib`, `spawn-helper`, and `t3-resource-monitor`; `:320` signs these plus the main executable. Developer ID signing adds runtime/timestamp; only the main executable gets CLI entitlements (`:326`).
- Missing identity produces ad-hoc signing and returns (`:333`); missing API credentials warns and returns (`:341`).
- `:351` zips **only the main executable**; `:355` submits using `--key`, `--key-id`, `--issuer`, `--wait`. Helpers/addons are signed but absent from this submission. The final archive is subsequently created at `:550`.

**Change:** add `APPLE_KEYCHAIN_PROFILE`/`APPLE_KEYCHAIN` config and profile-first authorization arguments `--keychain-profile goat-notary [--keychain <path>]`. Add `--require-notarization`, propagated from command options (`:567`) to signing (`:522`), rejecting ad-hoc identity or missing credentials. Request JSON output and require `status === "Accepted"`; current command handling checks exit status only. Consider submitting a temporary ZIP containing the complete CLI payload so helpers/addons are covered.

4. **Versioning, manifests, and publishing changes**

Concrete recommendations:

- `scripts/resolve-nightly-release.ts:96`: remove the patch increment (`"Number(patch) + 1"`), or add an explicit base-version override, to produce `0.1.0-nightly.YYYYMMDD.N`. Rename `"T3 Code"` to `"GOAT"` at `:124`.
- `scripts/release-smoke.ts:275`, `:280`, `:285`: update version/tag/name expectations accordingly.
- `scripts/update-release-package-versions.ts:49` already updates server, desktop, web, and contracts; `:100` changes only the version field. Reuse unchanged.
- `scripts/build-desktop-artifact.ts:65`: change the allowed update repository from `goat-si/goat` to `goat-si/goat-releases`; update corresponding tests (`scripts/build-desktop-artifact.test.ts:391`). Explicitly set `T3CODE_DESKTOP_UPDATE_FEED_ENABLED=true` and `T3CODE_DESKTOP_UPDATE_REPOSITORY=goat-si/goat-releases`. Otherwise `:2764`–`:2766` silently omit publishing configuration. GitHub provider/channel/prerelease configuration is at `:2772`.
- `.github/workflows/release-desktop.yml:335`, `:388`, `:538`, `:577`: replace export/API-key gates with existing-keychain identity/profile setup and required signing/notarization.
- `.github/workflows/release.yml:561`, `:585`: select the Mac Studio runner; preserve x64 CLI omission.
- Manifest merging accepts platform plus primary/secondary paths and optional output; default overwrites primary (`scripts/merge-update-manifests.ts:62`). It requires matching versions and rejects conflicting duplicate URLs (`scripts/lib/update-manifest.ts:213`, `:221`). Preserve mac/Windows merge steps at `release.yml:852` and `:864`.
- `release.yml:919` and `:935`: publish to `repository: goat-si/goat-releases` with a credential authorized there, replacing `github.token` at `:933`/`:948`. Preserve prerelease=true/latest=false (`:162`). Private source SHA `target_commitish` (`:924`, `:940`), generated notes, and previous-tag lookup must be adapted to the public release repository. Current publishing also requires npm publication (`:776`); remove that dependency if this channel delivers archives only.

**Uncertainties for parent:** runner labels/account/keychain access; practical x64 native rebuild and Rosetta verification; public-repository tag/notes policy; whether npm publication and all three bundled SSH runtimes belong in the nightly scope.
