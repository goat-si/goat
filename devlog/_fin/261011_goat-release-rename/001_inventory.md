# 001 — Inventory (research, gpt-6.1-sol read-only leaves, 2026-10-11)

Source: worktree /Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename at dfd768cb5. Three leaves (release / mcp / cli) ran read-only; key findings:

## Release resolution

- packages/shared/src/cliRelease.ts:8 CLI_RELEASE_REPOSITORY="pingdotgg/t3code"; :57 download base; :101 index URL (index ignores T3CODE_RELEASE_BASE_URL).
- packages/ssh/src/tunnel.ts REMOTE_RUNNER_SCRIPT acquisition (t3_fetch SHA256SUMS + archive via curl/wget, lines ~566-574); upload installer patches that block by anchors (~line 1016); prepareRemoteRuntime (~1092): ready -> local archive -> else remote download.
- packages/ssh/src/runtimeArchive.ts reads/hashes local archive, no SHA256SUMS check.
- apps/server/src/sshRemote/SshRemoteDispatch.ts:604-617 runner {archiveVersion: package version, archiveDirectory default <baseDir>/runtime/archives, keepExistingRunner, leaveRemoteServerRunning}; no releaseBaseUrl.
- apps/desktop/src/main.ts:110-135 runner {appVersion, archiveDirectory, optional releaseBaseUrl}.
- Anonymous consumers: apps/server/src/cli/update.ts:58 (index), cloud/pinnedRuntime.ts:132, selfUpdate.ts:183, bootService.ts:569, scripts/install.sh:20, install.ps1:19, apps/mobile/src/features/settings/environment-maintenance.ts:57, apps/marketing/src/lib/releases.ts:1, packaging/aur (PKGBUILDs + scripts/release.sh uses gh api).
- Tests asserting upstream URLs: packages/shared/src/cliRelease.test.ts:36,90; packages/ssh/src/tunnel.test.ts:228; fixture packages/ssh/src/fixtures/remote-runner-baseline.json (archive/node/mirror variants; frozen runner bytes protect managed-server restarts via cmp/RUNNER_CHANGED); scripts/build-npm-platform-packages.test.ts:258; web desktopUpdate/sidebar release-notes tests.
- gh from Effect: follow packages/ssh/src/command.ts:211 (ChildProcessSpawner, ChildProcess.make(cmd,args), extendEnv, concurrent stdout/stderr/exit collection, scoped timeout).

## MCP surface

- 83 tools; 42 use t3_ prefix across 8 toolkits (orchestrator 6, thread 16, project 7, worktree 3, ssh 3, attachment 3, environment 2, previewControls 2). Server name apps/server/src/mcp/McpHttpServer.ts:869 "T3 Code".
- 52 files reference the exact names (handlers, packages/shared/src/t3McpToolPresentation.ts, provider-core orchestrationInstructions/handoffBudget, contracts composerContext/worktreeMcp/previewAutomation, ServerBrowser, SshRemoteDispatch remote tools/call names, ContextHandoffDelivery, ClaudeAdapterV2 read-only approvals 965-985, docs/orchestration-v2/orchestrator-mcp-server.md, many tests).
- Provider registration key "t3-code" (36 more files: Codex mcp_servers, Cursor, Muse, ACP bridge/runtimeModel regexes, OpenCode per-thread names + deny rules, Pi exposure incl. hidden mcp__t3_code__ variant, instructions, fixtures).
- Persisted toolName is free string; keep read-side aliases. Claude stores approval toolName; Pi preserves public names for loadouts.
- Exclude unrelated t3_ ids (t3_context, t3_write_pty, t3_turn_*, metrics, cookies).

## CLI executable

- Producer: apps/server/vite.config.ts:88 exe.fileName "t3"; scripts/build-cli-archive.ts:101,470-487; cliArchiveFileName cliRelease.ts:54.
- Consumers: pinnedRuntime.ts:68,272-289; serviceLauncher.ts:52; tunnel.ts:510,563,587,598,1066 ($runtime/t3, probe); install.sh:175-221; install.ps1:154-217; build-npm-platform-packages.ts:115,182,220,335,344; legacyCliLauncher.ts:19; DesktopCliShim.ts:133; DesktopCliCommand.ts:143-269; DesktopWslEnvironment.ts:308-697; DesktopBackendConfiguration.ts:451; build-desktop-artifact.ts:3023,3479; smoke-cli-archive.ts:110; release.yml:818; release-desktop.yml:438; cli/invocation.ts; cli/update.ts:200.
- Help strings: binCli.ts, cli/{service,pair,connect,app,triagePrompt,uninstall}.ts, cloud/{CloudLink,relayResponse,selfUpdate,bootService}.ts, web onboarding/settings/update components, mobile ConnectionsNewRouteScreen, client-runtime serverBrowserStream, PreviewBrowserHost, apps/server/scripts/cli.ts.
- Keep: local default ~/.t3 and all upstream ~/.t3 data, T3CODE_*, npm package t3 and @t3code platform packages, .install-complete, run-t3.sh (persisted coordination; filename retained within the isolated remote root), service ids, /.well-known/t3, native helper names. D7 is decided: mandatory wp4 D7-A moves remote GOAT runtime to ~/.goat/runtime/goat/versions/<v>, SSH state to ~/.goat/ssh-launch and server home to ~/.goat; D7-B is discarded/not executable. wp2 runs before this isolation lands and must not start a GOAT server against ~/.t3/userdata.
- Compat risks: same-version runtime dir collision with upstream (SSH removes the dir before publishing); install scripts accept marker alone; do not overwrite an upstream t3 alias.

## Audit amendments (2026-10-11)

- 030 A11 composition preserves 010's four-argument downloader call: downloadRuntimeArchiveWithGh(directory, version, platformKey, runner?.ghCommand). wp4 retains runtimeArchiveGh.test.ts and its spaced-path ghCommand override regression in the final focused verification list.
- 010/030/050 test recipes run from the owning package with package-relative files, following 020's package-cwd convention. Packages without a local test config explicitly use the root config and --dir . as their package.json scripts do; typecheck/lint/syntax and stale-name gates reset to the source root. These are planned commands only; this amendment leaf ran no tests/builds/servers and made no source or git changes.
