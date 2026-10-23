---
name: test-goat-app
description: Test GOAT's web and desktop UI through its built-in Browser panel against isolated development state. Use for browser verification, browser pairing recovery, and test fixtures. Use test-goat-mobile for native mobile verification.
---

# Test GOAT web and desktop

Use GOAT's built-in Browser panel for verification. If its tools are absent or
the panel reports unavailable, explain the blocker and stop verification.
Do not install or switch to another automation system. For native mobile
testing, use [test-goat-mobile](../test-goat-mobile/SKILL.md).

## Start the app

Reuse this task's healthy dev server. Otherwise run `vp run dev` from the
repository root and retain its terminal session. Use the worktree's ignored
`.goat` state (`.t3` in a worktree created earlier) and read the actual ports and pairing URL from the dev-runner output.
Never run a server against `~/.goat/userdata` or `~/.t3/userdata`, and never set
`VITE_HTTP_URL` or `VITE_WS_URL`. `vp run migrate-dev-db` reads
`~/.goat/userdata/statev2.sqlite` (or `~/.t3/userdata/statev2.sqlite` when the
GOAT database is absent) and writes the worktree home.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Use the Browser panel

GOAT's browser tools run through `goat_call`. Call `goat_call {path:"preview.status"}`, then
`goat_call {path:"preview.open"}` if the Browser panel is closed. Navigate to the complete
startup pairing URL once with `goat_call {path:"preview.navigate", args:{url}}`, then use
`goat_call {path:"preview.snapshot"}` and the other `preview.*` paths that
`goat_describe {path:"preview"}` lists.
If the token was consumed or expired, run `node apps/server/src/bin.ts pair`
for a fresh one. Keep using the same tab.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the server, state, and panel available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.
