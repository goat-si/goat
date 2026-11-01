# 040 — wp4 runner, measurements, dry run, delivery

Depends on wp2 and wp3.

## 1. Mac Studio runner kit (NEW, not executed)

- `scripts/goat-mac-runner/install-runner.sh`: idempotent; args `--runner-dir ~/actions-runner/goat-mac-studio`. Downloads the pinned `actions-runner-osx-arm64-<ver>.tar.gz`, verifies the published SHA-256, extracts, then runs `./config.sh --url https://github.com/goat-si/goat --name goat-mac-studio --labels goat,mac-studio --work _work --unattended --replace` with the registration token read from **stdin** (never argv), then `./svc.sh install` and `./svc.sh start` (LaunchAgent in gui domain). Refuses to run when `launchctl managername` is not Aqua.
- `scripts/goat-mac-runner/preflight.sh`: checks Aqua session, Xcode CLT tools (codesign, notarytool, stapler, spctl), rustup targets aarch64/x86_64-apple-darwin, exactly one Developer ID Application identity for team U9ATA49N28, `notarytool history --keychain-profile goat-notary` succeeds, scratch `codesign` of a copied `/usr/bin/true` with the identity succeeds without UI (timeout 60 s); with `--ci` exports `CSC_NAME`, `CSC_KEYCHAIN`, `T3CODE_CLI_MAC_SIGN_IDENTITY` to `$GITHUB_ENV`. Prints no secret values.
- `docs/operations/goat-mac-release-runner.md`: what the runner is, the GitHub-side hardening (runner group restricted to goat-nightly.yml on the default branch, `goat-releases` environment reviewer), the user tasks in order (identity import with partition list, notary profile, rust, runner registration, power/FileVault notes, removal), and recovery.

## 2. Measurements

- M1 keychain session: done in wp0 (001). Re-run `preflight.sh` portions that do not need the identity.
- M3 x64 cross-build: unsigned `node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch x64` on this Mac (Rust x86_64 target needed: if Rust is absent, record which step fails and whether `--skip`-style options exist), then `lipo -archs`/`file` over every Mach-O in the app (all must be x86_64, none arm64-only), and record the time. Same for arm64 as the control.
- If x64 fails: alternatives (a) hosted `macos-15-intel` builds unsigned app, Mac Studio signs/notarizes/repacks; (b) drop x64 DMG for the first stage; (c) universal build on Mac Studio.

## 3. Dry run (unsigned)

`resolve-nightly-release` → `update-release-package-versions` (in a scratch copy) → `vp run build:desktop` → mac arm64 DMG+ZIP with feed env → CLI darwin-arm64 archive (if SEA toolchain available) → `verify-release-artifacts mac` (no signing) → fake per-arch manifests merge → SHA256SUMS → `verify-release-artifacts assemble` on the subset (with a `--allow-missing` flag for absent platforms) → `publish-nightly-release --dry-run` (prints the plan with no network writes). Logs in `evidence/`.

## 4. Two-Mac bootstrap (procedure only, 050 §11)

The final record repeats 050 §11 steps 1–5 as concrete user commands, adjusted for this implementation: the bootstrap release is the first nightly that contains wp3; both old 0.0.45 apps are quit and their login items/reconnect disabled before either new app starts; record `goat --version` on each SSH target after convergence.

## 5. Delivery

Final review by a different model family than each builder; fix blockers; `git push origin goat/release-nightly` (pre-push guard must pass with live GitHub workflow states); record HEAD; final cycle record with the user task list (commands) and remaining risks.
