# 000 — Completion webhook for launch watches

Follows the launch watch work of 10/11 (`840e58797`, `08ceb177e`, `7da51c258`).

## Loop spec

- Class: C3 (new persisted server setting with a secret, new MCP tool argument, outbound network call). PABCD.
- Branch: `cursor/goat-completion-webhook-0673`, base `dev`, one PR.
- Write scope: `packages/contracts/src/settings.ts`, `packages/shared/src/serverSettings.ts` (patch merge, if needed),
  `apps/server/src/serverSettings.ts` (secret storage), `apps/server/src/mcp/{launchWatch,LaunchWatchService,completionWebhook}.ts`,
  `apps/server/src/mcp/toolkits/{project,ssh}/{tools,handlers}.ts`, `docs/orchestration-v2/orchestrator-mcp-server.md`, this unit.
- Out of scope: web/mobile settings UI (setting is edited through `settings.json` or the settings RPC), webhooks for
  thread-less launchers, new dependencies.

## Problem

A launch watch wakes the launcher thread when a launched thread's run ends, waits on a question, or its host stays
unreachable. An agent outside GOAT (for example Grok Bot) that drives work through a GOAT thread never sees that wake.

## Decisions

- **D1 Setting.** `completionWebhook: { enabled: false, url: "", secret: "", allLaunches: false }` in `ServerSettings`
  and a partial `completionWebhook` in `ServerSettingsPatch`. The secret follows the Bitbucket token path: stored in the
  secret store, `••••••` on disk and toward clients; sending the marker keeps it, `""` clears it.
- **D2 Opt-in per launch.** `notifyWebhook?: boolean` on `goat_thread_launch` and `goat_ssh_thread_launch`, persisted on
  the watch (`LaunchWatch.notifyWebhook`, decoding default `false`, so old state files load). A watch POSTs only if
  `enabled && url !== "" && (watch.notifyWebhook || allLaunches)`. `allLaunches` also covers watches made by
  `goat_thread_watch`, for an operator who wants every report without changing prompts. `notifyWebhook` rides on the
  launch watch: with `notifyOnCompletion:false` there is no watch and no webhook. Re-registering a watch without the
  flag keeps its value. The way out: `enabled:false` stops new and retrying deliveries; `goat_thread_unwatch` ends the
  watch.
- **D3 When.** In `deliver()`, only after the wake is settled (`delivered: true`, which includes a permanent refusal).
  Events: `run.completed` (any terminal status; `status` carries completed/failed/cancelled/...), `question`,
  `host.unavailable`. The "thread can no longer be followed" wake is not posted (not requested; it is not a run result).
- **D4 Payload.** JSON
  `{ id, event, threadId, runId, requestId?, host, title, status, summary, excerpt, prUrl?, launcherThreadId, at }`.
  `id` is the wake's base command id, stable per event, also sent as `x-goat-delivery`. `host` is the SSH alias or
  `null` for this environment. `status` is the run status, `waiting` for a question, `unreachable` for an outage.
  `summary` is the wake's notification summary; `excerpt` the last assistant message of the run (≤1500 chars) or `null`.
  `prUrl` is the thread's linked pull request, when known. `at` is ISO-8601.
- **D5 Signing.** Headers `content-type: application/json`, `x-goat-event: <event>`, `x-goat-delivery: <id>`,
  `x-goat-signature: sha256=<hex HMAC-SHA256 of the exact body bytes with the secret>`. Without a secret the signature
  header is omitted. Same scheme GOAT accepts on inbound scheduled-task webhooks.
- **D6 Never blocks the wake.** A new `CompletionWebhook` service (`completionWebhook.ts`) forks each delivery into its
  own scope and returns at once; `deliver()` ignores its outcome.
- **D7 Retry and dedupe.** 2xx succeeds. Network errors, timeouts (10 s), 408, 429 and 5xx retry with the launch watch
  backoff (`backoffMs`: 30 s, 60 s, 120 s, 240 s, 480 s between the 6 attempts); other statuses stop. Settings are
  re-read before each attempt, so disabling or rotating the secret applies to retries. An in-memory set of the last 500
  delivery ids drops a second POST for the same run (or question, or outage episode) in this process. Delivery is best
  effort and not part of the watch's state write: a report whose POST has not succeeded when the server stops is lost
  (the run is already settled, so it is not replayed), and a wake replayed after a crash between dispatch and the state
  write can post again with the same `id`, so receivers dedupe on `x-goat-delivery`. No outbox, by choice.
- **D8 Thread-less launchers are out of scope.** A launch from an MCP client without a GOAT thread records no watch
  today (`caller === undefined`), so it gets no webhook either. Supporting it needs watches without a launcher thread
  (wake skipped, runtime ceiling stored on the watch). Follow-up if wanted; the external agent should launch through
  a GOAT thread it owns.

## Verification

- `launchWatch.test.ts`: old watch documents decode with `notifyWebhook: false`.
- `completionWebhook.test.ts`: payload shape per event, signature verifies with `verifyWebhookSignature`, disabled /
  not-opted-in / empty URL post nothing, `allLaunches` posts, transient failure retries with backoff then succeeds,
  permanent 4xx stops, same id posts once.
- `LaunchWatchService.test.ts`: a finished run calls the webhook once with run details after the wake; a failing
  webhook does not hold the wake.
- `serverSettings.test.ts`: secret goes to the secret store and is redacted for clients.
- Handler tests: `notifyWebhook` reaches the watch.
