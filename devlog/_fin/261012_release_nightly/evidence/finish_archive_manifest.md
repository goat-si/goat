# Finish wp3 — real archive, manifest merge and fail-closed proofs (2026-10-12, local, unsigned)

Scratch worktree /tmp/goat-finish-dry at 0c66d068e (same tree as the PR head except the packages/contracts/src/ipc.test.ts decoder hoist and devlog text). Node 26.11.1 for the SEA step (CI pins 26.8.2), Rust from an isolated /tmp/goat-rust (aarch64 + x86_64), update feed env as in goat-nightly.yml (T3CODE_DESKTOP_UPDATE_FEED_ENABLED=true, T3CODE_DESKTOP_UPDATE_REPOSITORY=goat-si/goat-releases). No signing identity, notary profile, publish credential or network write.

## 1. Version and real CLI archive (prepare + cli darwin-arm64 steps)

```
check-release-version: ok
VERSION=0.1.0-nightly.20261012.1 (resolve-nightly-release.ts --date 20261012 --run-number 1), matches ^0.1.0-nightly.YYYYMMDD.N$
build:desktop 58s, build-exe 8s
cli-archive-exit=0
-rw-r--r--   1 jun  wheel  80388792 Oct 12 15:55 goat-0.1.0-nightly.20261012.1-darwin-arm64.tar.gz
[15:55:24.900] INFO (#1): [cli-smoke] goat-0.1.0-nightly.20261012.1-darwin-arm64: --version passed and serve answered on 47700.
smoke-exit=0
payload-exit=0
{"key":"cli-mac-arm64","mode":"payload","version":"0.1.0-nightly.20261012.1","inputs":[{"name":"goat-0.1.0-nightly.20261012.1-darwin-arm64.tar.gz","sha256":"b7ea06359a6e13efea171181226caff8ae7b473dc404cbe013c159289c2b7a4b"}],"ok":true,"checks":["payload-hashes","goat-0.1.0-nightly.20261012.1-darwin-arm64.tar.gz: exposure-scan"],"problems":[]}
```

## 2. CLI notarization gate without credentials (expected refusal)

```
== CLI --require-notarization without a notary profile (expect refusal)
require-notarization-exit=1
[15:53:17.971] ERROR (#1): CliNotarizationCredentialsMissingError: Required notarization needs a Developer ID in T3CODE_CLI_MAC_SIGN_IDENTITY; ad hoc signing is not allowed.
```

## 3. Unsigned mac arm64 + x64 builds, manifest merge, entry check

```
rust-install-exit=0
aarch64-apple-darwin
x86_64-apple-darwin
desktop-arm64-exit=0 77s
GOAT-0.1.0-nightly.20261012.1-arm64.dmg
GOAT-0.1.0-nightly.20261012.1-arm64.dmg.blockmap
GOAT-0.1.0-nightly.20261012.1-arm64.zip
GOAT-0.1.0-nightly.20261012.1-arm64.zip.blockmap
nightly-mac.yml
desktop-x64-exit=0 82s
GOAT-0.1.0-nightly.20261012.1-x64.dmg
GOAT-0.1.0-nightly.20261012.1-x64.dmg.blockmap
GOAT-0.1.0-nightly.20261012.1-x64.zip
GOAT-0.1.0-nightly.20261012.1-x64.zip.blockmap
nightly-mac.yml
== done
script-exit=0
== manifests before merge
version: 0.1.0-nightly.20261012.1
files:
  - url: GOAT-0.1.0-nightly.20261012.1-arm64.zip
    sha512: 5tM0AZ2bXJfWHAcnrDHEzNQdyz6Bo5i0RxltquWcsNJzgGtk+Y0+N7dzjZjfsmBrw2Ms5o9lksWaICgun8Z5fg==
    size: 231208506
  - url: GOAT-0.1.0-nightly.20261012.1-arm64.dmg
    sha512: WKy5vbLpF2l1YOT4cPnUM8gkG5e0Tse+sUdqtOX8a+A8FrEGRycNiBGerMrh2y+hlc8eDDm/bANRVVn4MLeeKw==
    size: 237880895
path: GOAT-0.1.0-nightly.20261012.1-arm64.zip
sha512: 5tM0AZ2bXJfWHAcnrDHEzNQdyz6Bo5i0RxltquWcsNJzgGtk+Y0+N7dzjZjfsmBrw2Ms5o9lksWaICgun8Z5fg==
releaseDate: '2026-10-12T06:58:26.066Z'
--
version: 0.1.0-nightly.20261012.1
files:
  - url: GOAT-0.1.0-nightly.20261012.1-x64.zip
    sha512: 8nkHAGWt3DeMd/fJk5CMAhJX3XEHz1fqbS5h2cPtBf0U1gpR/zCMxh6SU3fEpjYvJkm7258q6L0dY8GCY2pfoA==
    size: 235716487
  - url: GOAT-0.1.0-nightly.20261012.1-x64.dmg
    sha512: vzrZNDRHwKvWG+GI+9ALLtszpQ2NaDgB0JmfyEfjx1mQ4j0gqg3ie4FiQIqA74pkUd9QvAc5ds988uXqgOvLbA==
    size: 242438758
path: GOAT-0.1.0-nightly.20261012.1-x64.zip
sha512: 8nkHAGWt3DeMd/fJk5CMAhJX3XEHz1fqbS5h2cPtBf0U1gpR/zCMxh6SU3fEpjYvJkm7258q6L0dY8GCY2pfoA==
releaseDate: '2026-10-12T06:59:47.577Z'
merge-exit=0
== merged nightly-mac.yml
version: '0.1.0-nightly.20261012.1'
files:
  - url: GOAT-0.1.0-nightly.20261012.1-arm64.zip
    sha512: 5tM0AZ2bXJfWHAcnrDHEzNQdyz6Bo5i0RxltquWcsNJzgGtk+Y0+N7dzjZjfsmBrw2Ms5o9lksWaICgun8Z5fg==
    size: 231208506
  - url: GOAT-0.1.0-nightly.20261012.1-arm64.dmg
    sha512: WKy5vbLpF2l1YOT4cPnUM8gkG5e0Tse+sUdqtOX8a+A8FrEGRycNiBGerMrh2y+hlc8eDDm/bANRVVn4MLeeKw==
    size: 237880895
  - url: GOAT-0.1.0-nightly.20261012.1-x64.zip
    sha512: 8nkHAGWt3DeMd/fJk5CMAhJX3XEHz1fqbS5h2cPtBf0U1gpR/zCMxh6SU3fEpjYvJkm7258q6L0dY8GCY2pfoA==
    size: 235716487
  - url: GOAT-0.1.0-nightly.20261012.1-x64.dmg
    sha512: vzrZNDRHwKvWG+GI+9ALLtszpQ2NaDgB0JmfyEfjx1mQ4j0gqg3ie4FiQIqA74pkUd9QvAc5ds988uXqgOvLbA==
    size: 242438758
releaseDate: '2026-10-12T06:59:47.577Z'
== entry check against the built files
ok  GOAT-0.1.0-nightly.20261012.1-arm64.zip 231208506
ok  GOAT-0.1.0-nightly.20261012.1-arm64.dmg 237880895
ok  GOAT-0.1.0-nightly.20261012.1-x64.zip 235716487
ok  GOAT-0.1.0-nightly.20261012.1-x64.dmg 242438758
version 0.1.0-nightly.20261012.1 entries 4 archs ['arm64', 'x64']
app-update.yml in the arm64 app: owner goat-si, repo goat-releases, provider github, releaseType prerelease, channel nightly
bundled SSH runtime: Resources/ssh-runtime/archives/goat-0.1.0-nightly.20261012.1-darwin-arm64.tar.gz + .sha256
```

## 4. Fail-closed gates on the unsigned builds (expected refusals)

```
== signing gate on the unsigned arm64 build (expect refusal)
mac-verify-exit=1
[16:00:45.754] ERROR (#1): ReleaseVerificationError: GOAT-0.1.0-nightly.20261012.1-arm64.dmg: codesign verification failed: /private/tmp/goat-finish-dry/release3-arm64/GOAT-0.1.0-nightly.20261012.1-arm64.dmg: code object is not signed at all
GOAT-0.1.0-nightly.20261012.1-arm64.dmg: spctl verification failed: /private/tmp/goat-finish-dry/release3-arm64/GOAT-0.1.0-nightly.20261012.1-arm64.dmg: rejected
GOAT-0.1.0-nightly.20261012.1-arm64.dmg: app staple GOAT (Nightly).app: Processing: /var/folders/07/pv7qpvg55cq8nn8k_8lnqklc0000gn/T/goat-verify-KDAF1k/payload/GOAT (Nightly).app
GOAT (Nightly).app does not have a ticket stapled to it.
GOAT-0.1.0-nightly.20261012.1-arm64.dmg: app staple GOAT (Nightly).app/Contents/Frameworks/GOAT (Nightly) Helper (GPU).app: Processing: /var/folders/07/pv7qpvg55cq8nn8k_8lnqklc0000gn/T/goat-verify-KDAF1k/payload/GOAT (Nightly).app/Contents/Frameworks/GOAT (Nightly) Helper (GPU).app
GOAT (Nightly) Helper (GPU).app does not have a ticket stapled to it.
GOAT-0.1.0-nightly.20261012.1-arm64.dmg: app staple GOAT (Nightly).app/Contents/Frameworks/GOAT (Nightly) Helper (Plugin).app: Processing: /var/folders/07/pv7qpvg55cq8nn8k_8lnqklc0000gn/T/goat-verify-KDAF1k/payload/GOAT (Nightly).app/Contents/Frameworks/GOAT (Nightly) Helper (Plugin).app
GOAT (Nightly) Helper (Plugin).app does not have a ticket stapled to it.
== assemble (expect refusal: unsigned DMGs; other platforms not built here)
notices-exit=0
assemble-exit=1
[16:00:47.766] ERROR (#1): ReleaseVerificationError: missing asset: GOAT-0.1.0-nightly.20261012.1-amd64.deb
missing asset: GOAT-0.1.0-nightly.20261012.1-arm64.AppImage
missing asset: GOAT-0.1.0-nightly.20261012.1-arm64.deb
missing asset: GOAT-0.1.0-nightly.20261012.1-arm64.exe
missing asset: GOAT-0.1.0-nightly.20261012.1-arm64.exe.blockmap
missing asset: GOAT-0.1.0-nightly.20261012.1-x64.exe
missing asset: GOAT-0.1.0-nightly.20261012.1-x64.exe.blockmap
missing asset: GOAT-0.1.0-nightly.20261012.1-x86_64.AppImage
missing asset: goat-0.1.0-nightly.20261012.1-linux-arm64.tar.gz
missing asset: goat-0.1.0-nightly.20261012.1-linux-x64.tar.gz
missing asset: goat-0.1.0-nightly.20261012.1-win32-arm64.zip
missing asset: goat-0.1.0-nightly.20261012.1-win32-x64.zip
missing asset: nightly-linux-arm64.yml
missing asset: nightly-linux.yml
missing asset: nightly.yml
unexpected asset: GOAT-0.1.0-nightly.20261012.1-arm64.dmg.blockmap
unexpected asset: GOAT-0.1.0-nightly.20261012.1-x64.dmg.blockmap
missing DMG finalization transform: GOAT-0.1.0-nightly.20261012.1-arm64.dmg
missing DMG finalization transform: GOAT-0.1.0-nightly.20261012.1-x64.dmg
expected one mac report: desktop-mac-arm64
expected one mac report: desktop-mac-x64
```

Reading: the mac signing gate refuses an unsigned DMG (codesign, spctl, missing staple). Assemble refuses for three separate reasons: platforms not built on this Mac (Windows, Linux, their CLI archives and manifests), unsigned DMGs without the finalize transform and mac reports, and DMG blockmaps that finalize-macos-dmg removes in CI (scripts/finalize-macos-dmg.ts:146). The first is expected for a local run; the second is the fail-closed proof.
