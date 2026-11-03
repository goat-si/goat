# 040 — wp4: docs, runtime proof, PR, CI, review, merge, report

## Docs
- docs/internals/server-updates.md "Recovering interrupted threads" (:130-160): one paragraph — Codex app-server lives outside the
  server process during restarts; retention depends on the stop reason; adoption vs continuation fallback; MCP tools unavailable for
  the rest of an adopted turn; orphan ownership (records, verified group termination, startup sweep). Rewrite, do not append history.
- docs/user/updating.md restart-continuation section (:213 area): the new setting, what each value does, the quit default.
- structure/: only if a module boundary note is needed for CodexDetachedAppServers (check structure/manifest.json for provider/).

## Surfaces (AGENTS "Hit every surface")
- Entry points: setting in web Settings; agents via goat_environment_settings_update (SETTINGS_ACCESS agent).
- Clients: server-only behavior; web/desktop/mobile show the same continuation runs. Mobile settings screen: check whether it lists
  continueThreadsAfterServerUpdate; mirror if so.
- Providers: Codex only. Claude/Cursor/OpenCode/Grok/Antigravity/ACP: "not supported here" (they keep today's behavior).
- Connection modes: SSH remote runtimes run the same server code on the remote host; runtimeDrain marks restart, so remote updates keep
  Codex turns. Windows hosts: stdio only.
- Reverse state: setting "off" returns to today's behavior; a retained process is always either claimed or terminated.

## Runtime proof (isolated, no paid model)
vp run dev in this worktree (own .goat), Codex provider instance with homePath = temp CODEX_HOME whose config.toml points to the mock
Responses server from 001; start a turn, hold the mock, restart the dev server by its tracked PID (desktop-stop-intent not
applicable: write the in-process mark via a drain, or set the setting to "always"), release the mock, observe the continuation run
complete with the adopted turn's agent message and no second responses request. Record transcript + fd/process counts for c-6.
Stop everything by tracked PIDs; remove temp dirs.

## Delivery
vp run check:changed (exit 0) -> push -> PR to dev (conventional title "feat(server): Codex turns keep running through server
restarts"; body: problem, design, degradation (goat_* tools in adopted turn), setting default rationale, tests, runtime transcript,
NOT RUN, model+harness) -> goat_pull_request_link + watch -> fix bot findings -> fresh independent review PASS ->
exact-head goat-ci-result SUCCESS -> rebase only if CONFLICTING (thread 3 merge) -> node scripts/merge-pr.ts <pr> ->
origin.report (PR URL, merge SHA, experiment results, NOT RUN) + 005 token-handoff proposal pointer for the parent.

