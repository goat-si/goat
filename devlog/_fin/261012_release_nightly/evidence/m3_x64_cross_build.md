# M3 — x64 (Intel) DMG cross-build on the arm64 Mac Studio (2026-10-12)

Unsigned, local, source fc270090f in a scratch worktree (package versions set to 0.1.0-nightly.20261012.1), Rust from an isolated /tmp/goat-rust (aarch64 + x86_64 targets), JS bundle from `vp run build:desktop` (27 s wall).

| Build           | Command                                                                                                       | Result                                                                                | Wall time |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------- |
| arm64 (control) | `build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --skip-build` + feed env + payload report | DMG 157.9 MB, ZIP 151.6 MB, blockmaps, nightly-mac.yml; payload report ok, 0 problems | 38 s      |
| x64             | same with `--arch x64`                                                                                        | DMG 162.4 MB, ZIP 156.1 MB, blockmaps, nightly-mac.yml; payload report ok             | 52 s      |

Architecture audit of every Mach-O in the unpacked ZIP (`lipo -archs`):

- x64 app: 31 Mach-O files, 30 contain x86_64. The one without is `objc-js/prebuilds/darwin-arm64/node.napi.armv8.node`, an unused prebuild; the matching `prebuilds/darwin-x64/node.napi.node` is present.
- arm64 app (control): 31 files, 30 contain arm64; the exception is the unused `objc-js/prebuilds/darwin-x64` prebuild.

Signing: `codesign --force --sign - --options runtime` on a copy of the x64 main executable succeeds and `codesign --verify --strict` reports "valid on disk / satisfies its Designated Requirement", so codesign handles x86_64 Mach-O on this arm64 host. Developer ID signing and notarization are architecture-independent operations on the same files; they were not run (no identity installed yet).

Execution: `arch -x86_64 <x64 executable>` fails with "Bad CPU type in executable" because Rosetta 2 is not installed. Nothing x64 can be smoke-run on this Mac; the CI x64 job therefore cannot run x64 smoke tests (none are planned there; the CLI smoke test runs only for darwin-arm64).

Verdict: the x64 DMG can be built and signed on the Mac Studio. The remaining unmeasured risks are the first real Developer ID signature + notarization of the x64 app (wp4 user task) and a runtime launch on an Intel Mac or under Rosetta (`softwareupdate --install-rosetta --agree-to-license`, optional user task). Optional cleanup: exclude the other architecture's `objc-js` prebuild like node-pty (`build-desktop-artifact.ts` ~:1058).
