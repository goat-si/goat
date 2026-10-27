# 050 — wp5: stabilize, replace the app, live verification, push

## Loop spec

Archetype: verification + release-to-branch. Trigger: user "안정화해놓고 앱 교체해놓고 푸시해". Goal: user runs a packaged GOAT build that supplies its own runtime; remote switching is safe; branch pushed with goat-ci green and dev fast-forwarded. Non-goals: notarization, GitHub release, PR, main. Verifier: evidence files below + goat-ci run conclusion. Stop: all green or NEEDS_HUMAN (mac-studio offline, Claude login). Escalation: pre-push guard failure, CI red (record root cause, no force).

## Steps (V = 0.0.45 for every artifact; product GOAT.app)

1. Integration check on HEAD: rerun the cycle receipts' focused bundles together + tsc for touched packages; failures loop back via P amendment.
2. Build: `vp run dev:runtime-archive` (exercise it; produces goat-0.0.45-darwin-arm64.tar.gz + .sha256), then `env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY vp run dist:desktop:artifact --platform mac --arch arm64 --target dmg --build-version 0.0.45 --ssh-runtime-archive-dir <dir> --keep-stage` (flags re-verified at P). Evidence: bundle id, product name GOAT, resources/ssh-runtime/archives listing + sidecar, no app-update.yml feed, `goat --version` in the bundled archive = 0.0.45, sizes.
3. Replace: stop the dev desktop we spawned (owner of its server port with cwd in our worktree), install /Applications/GOAT.app from the DMG (ditto), launch, confirm data home ~/.goat/desktop and saved juns-macbook-pro connection.
4. Live on juns-macbook-pro (never touch ~/.t3): (a) update-safe switch (unobtainable version → error, old runner bytes/pid/process unchanged); (b) cold host per Reflection fold → bundled upload, no gh; (c) protocol reuse via harness (0.0.46-nightly.20261011.2 request reuses running 0.0.45); (d) dispatch probe from the installed app's server completes.
5. Push: record HEAD SHA S after final review; `git push origin S:refs/heads/goat/ssh-runtime-supply` (pre-push guard active, no bypass, no force); find goat-ci run for headSha S on branch goat/ssh-runtime-supply (then for dev: headSha S and headBranch dev) (`gh run list -R goat-si/goat --workflow goat-ci.yml --json headSha,status,conclusion,databaseId`), `gh run watch` until completed, require conclusion success; then `git fetch origin` and `git merge-base --is-ancestor origin/dev S` must hold, then `git push origin S:refs/heads/dev` (fast-forward only) and watch goat-ci for dev at S. Authority: user instruction "푸시해" (2026-10-11) for this work; interpreted as branch + fast-forward dev and reported.
6. mac-studio: if online, copy the DMG and install GOAT.app alongside existing apps; else NEEDS_HUMAN with commands.

## Reflection fold (A2–A5)

- Version sync: wp5 builds with one version V for every artifact. Use V = apps/server/package.json version (0.0.45) for --build-version, the CLI archive name and the SEA binary, so the bundled archive, the packaged server and `goat --version` agree (verify all three in evidence).
- Rollback: before installing, record existing /Applications entries; nothing named GOAT exists on this Mac; the dev desktop stays runnable from the worktree as rollback. On mac-studio, never overwrite "T3 Code (Nightly).app" (different name); GOAT installs alongside.
- Credentials: after launch, show the saved juns-macbook-pro connection reconnecting in the packaged app (Safe Storage name kept); if decryption fails, record it and re-add the connection (limitation).
- Bundle-id change: macOS TCC permissions (screen recording, accessibility) start ungranted for the new bundle id — recorded limitation.
- Cold host for bundled acquisition: stop the GOAT server we started earlier (pid in 261011_goat-release-rename evidence, ours) and move our own ~/.goat/runtime/goat/versions/0.0.45 aside to a dated backup under ~/.goat, run the app connection, then verify upload from the bundle without gh; restore nothing else.
- Protocol reuse live: with the 0.0.45 server running, run prepareRemoteRuntime/launch via the harness requesting 0.0.46-nightly.20261011.2 → reused, no acquisition. Incompatibility rejection is proven by isolated-HOME real-shell tests (live host scenario would disturb the running server; disposition recorded).
- Install path: with V=0.0.45 the stable product is `GOAT.app`; steps 2–3 install and launch `/Applications/GOAT.app` (not "GOAT (Nightly).app").

## Amendments after audit 01a1297a (HEAD b32fe81d1)

- Build Node: Homebrew node lacks the SEA fuse; use the official nodejs.org v26.11.1 darwin-arm64 binary (sha256 verified) at /tmp/goat-node26 first on PATH, VP_NODE_VERSION=26.11.1.
- Paths: archive = /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/.t3/runtime/archives/goat-0.0.45-darwin-arm64.tar.gz (+ .sha256); DMG via `--output-dir /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/release` = release/GOAT-0.0.45-arm64.dmg; installed archives at /Applications/GOAT.app/Contents/Resources/ssh-runtime/archives/. Evidence adds CFBundleIdentifier=si.goat.desktop, SHA-256 of DMG and installed archive, `goat v0.0.45`, no Resources/app-update.yml.
- Pre-cycle-4 server pid 44450 (managed, no identity file): first connect from the new app is expected to be REFUSED with ownership preserved (record error + unchanged pid/runner/state). Then the parent, after confirming that pid's command is our earlier `~/.goat/runtime/goat/versions/0.0.45/goat serve ... --base-dir ~/.goat` spawn, stops it by captured PID; back up (move aside, dated, under ~/.goat) the 0.0.45 version dir and that launch state dir's pid/port/managed/run-t3.sh and the server runtime descriptor; no identity is fabricated.
- (a) Acquisition failure preservation is not reproducible live while a protocol-compatible server exists (compatible reuse precedes acquisition). Disposition: proven by isolated-HOME real-shell tests (cycles 1 and 4); live evidence is the (pre-cold) refusal preserving pid 44450.
- (b) Cold connect from the installed app: bundled upload, no gh, new server with identity.
- (c) Protocol reuse: harness calls launchOrReuseRemoteServer(target, auth, {archiveVersion:"0.0.46-nightly.20261011.2"}) (no nodeScriptPath) against the server from (b); expect selectedRuntime.requestedVersion = nightly, version 0.0.45, source live|retained, same pid/port, no upload/gh/download; record both protocol values.
- Push CI: `gh run list -R goat-si/goat --workflow goat-ci.yml --json databaseId,headSha,headBranch,event,status,conclusion`, match event=push + branch + headSha=S. Order: branch CI success → fetch + ancestor check → push dev → dev CI success. cancelled ≠ success. goat-ci does not package the DMG; local packaged evidence stays separate.
