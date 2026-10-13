# ADR-0013 — decision recorded under "Replacement"

- Contract owner: [ssh.md](../ssh.md#replacement)
- Issue: goat-si/goat#119

## Decision record

- **Purpose.** Replace a shared SSH runtime with a new version without cancelling work any client
  started on it. Never kill a server that cannot cooperate.
- **Before.** The launch script asked `/activity`, and on `idle` it signalled the server itself. A
  turn admitted between the answer and the signal was interrupted. Every older owned runtime was
  eligible, and compatibility compared exact integers or the exact release.
- **Alternatives.**
  - Keep the client-side kill and shorten the race. The race remains.
  - Add a new snapshot file of loaded threads, as the Codex app-server does. Restart recovery
    already persists restart continuations on `SIGTERM` and restores them at startup, so a second
    format would duplicate it.
  - Push drain notices as a new lifecycle event to every subscriber. Clients that predate the event
    would fail to decode their lifecycle stream.
- **Decision.**
  - The server drains and stops itself. A per-start `instanceId` and a host-user control token
    guard the request.
  - A detached supervisor swaps versions and rolls back after a failed handshake.
  - Servers without `drainRestart` are attach-only.
  - Compatibility comes from protocol ranges through one comparator.
  - Drain notices go only to lifecycle subscribers that opt in.
- **Reasons.** Only the server knows what it admits, so only it can close the admission race. The
  supervisor outlives the SSH session that started it.
- **Tradeoffs.**
  - A runtime from before this change is never upgraded automatically. Its user stops it once, by
    hand.
  - An automatic refresh still waits for an idle answer, so a busy server is refreshed later.
  - A rollback restores the database copied after the drain, discarding anything the failed
    version wrote.
