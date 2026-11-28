# engine-helper stdio protocol (v1)

`apps/engine-helper` runs GOAT v1 engines that only exist as Node SDKs (Cursor @cursor/sdk,
OpenCode @opencode-ai/sdk/v2, Muse @muse-code/sdk) behind one stdio shape. The Rust side is
crates/goat2-engine-sdk (HelperFactory), which implements goat2-engine-api over it.

## Processes

- **One helper process per GOAT thread**, started by the host like a Codex app-server: own process
  group, nice +10, killed with its group. A crash (SDK bug, OOM, process.exit in a library) ends
  only that thread's run; other threads and engines keep running.
- Entry: node apps/engine-helper/src/main.ts (Node >= 22.18 strips types; GOAT 2 pins 26.12.1).
  SDK packages stay in node_modules beside the entry (the Cursor SDK loads Webpack chunks and
  native modules from disk, v1 provider-cursor/src/server/sdk.ts:1-6).
- stdout carries protocol lines only. The helper re-routes console.* and stray
  process.stdout.write to stderr before any SDK loads. stderr is diagnostics; the host keeps a
  tail and never logs credentials from it.
- stdin closing means the host is gone: the helper shuts the engine down and exits.

## Framing

UTF-8 JSON, one object per line, LF-terminated (a trailing CR is stripped). Lines that are not JSON
objects are ignored and logged by length only (v1 provider-pi/src/server/rpc.ts framer rule).

## Host -> helper: requests

Every request has a numeric id and gets exactly one response {id, result} or
{id, error: {code, message}}. code is one of bad_request | unavailable | start_failed | transport,
mapped to EngineError on the Rust side.

| method | params | result |
|---|---|---|
| initialize | {protocol: 1, engine: cursor/opencode/muse/fake, threadId, cwd, resume: string or null, modelSelection, runtimeMode, mcp: {url, bearerToken}, instructions: string or null, launch: {binary?, args?, env?} or null} | {engineRef} (the engine's own session id, written to the card) |
| turn.start | {inputs: [{inputId, text, attachments}], settings: {modelSelection, runtimeMode}} | TurnStartResult |
| turn.steer | {turnId, inputs} | SteerResult |
| turn.interrupt | {turnId} | {} |
| request.answer | {key, answer: {outcome, text?, answers?}} | {} |
| shutdown | {} | {}, then the helper exits 0 |

TurnStartResult: {status: "accepted", turnId} or {status: "declined" / "refused_unowned" / "unknown",
reason}. SteerResult: {status: "accepted"} or {status: "declined" / "refused_unowned" / "unknown",
reason}. Same meaning as goat2-engine-api (structure/30_wire.md).

## Helper -> host: events

{event: EngineEvent} lines, in order. EngineEvent mirrors goat2_engine_api::EngineEvent:

| type | fields |
|---|---|
| text_delta | turnId, itemId, text (never stored) |
| item_completed | turnId, item, locator: {turnId, itemId} or null |
| request_opened | turnId, key, itemId or null, kind: approval/question/signin, summary, item or null |
| request_closed | key |
| turn_finished | turnId, outcome: {type: "done"} / {type: "failed", reason} / {type: "interrupted"} |
| exited | reason (the engine is gone; the helper exits right after) |

item is a goat2-contracts TurnItem without threadId, runId, ordinal and providerThreadId; the Rust
driver fills those (thread id from the session, ordinal counted per session, provider thread id =
engineRef) and validates the result against TurnItem. An item that does not validate is dropped with
a log line, never forwarded half-formed.

{log: {level: debug/info/warn/error, message}} lines are diagnostics for the host log.

## Fakes

engine "fake" is a scripted engine for driver tests: plain text echoes with deltas, "ask" opens a
question, "approve" opens an approval, "crash" exits mid-turn, "hang" never finishes until
interrupted. Per-engine fake SDKs replace the real package: GOAT2_ENGINE_HELPER_SDK_<ENGINE>=<module
path> (for example GOAT2_ENGINE_HELPER_SDK_CURSOR) makes the engine import that module instead of
the npm package. Tests never need a login or a network.
