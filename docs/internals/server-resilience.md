# Server resilience

One GOAT server process carries every session on the machine: the WebSocket clients, every
provider adapter, the hub and device proxies, screen runs, and SQLite. Anything that kills that
process drops every connected client and every in-flight turn at once; one unobserved `'error'`
event has restarted the server 21 times in a day. The rules below are mandatory for code that
runs in the server or the desktop main process. A review that finds a violation rejects the
change.

## Every error source has a listener from birth

Node terminates the process when an `EventEmitter` emits `'error'` with no listener. Effect
code does not protect you here: these events fire from callbacks outside any fiber.

- Create emitters inside `guardErrors` or `guardChild` from [`@goat/shared/errorGuards`](../../packages/shared/src/errorGuards.ts),
  with a route that ends or fails the owner. `guardChild` gives stdout, stderr and extra pipes
  the child's route; only stdin may take its own route. `goat/guard-error-emitters` enforces this
  in `apps/server` and packages; exceptions need a reasoned `oxlint-disable`.
- A `child.once("error")` does not cover `child.stdin`. Writing to the stdin of a child that
  closed its end raises `EPIPE` on the stdin stream; on Windows a write to a dead child fails with `EOF`.
- A library may detach its own error listener before closing a resource. A `ws` socket released
  while still connecting emits its teardown error after Effect's socket has stopped listening,
  so the code that creates the socket keeps a listener for its whole life
  ([hubProxy/http.ts](../../apps/server/src/hubProxy/http.ts)).
- The listener routes the failure into that resource's cleanup path: fail the owning Effect,
  close the session, mark the run. An empty listener is allowed only with a one-line comment
  naming where the failure is otherwise observed.
- Use `stream.pipeline` instead of chained `.pipe()`, so an error on any stage reaches one
  callback.
- A fix for a crash path ships a test that fails on `dev` with the escaped error.

## Never resume after an uncaught exception

Node does not guarantee consistent state after `uncaughtException`. Do not register
`process.on("uncaughtException")` or `process.on("unhandledRejection")` anywhere except
[`@goat/shared/processErrorNet`](../../packages/shared/src/processErrorNet.ts), the last-resort
handler the server installs at startup. It logs every uncaught error and unhandled rejection, then
exits 1 so the desktop supervisor restarts the server, except for the reviewed entries below.
Swallowing anything else hides state corruption.

The teardown entries also require the error to be an `'error'` event that nobody heard: Node
marks those, and a plain `throw` from our own code is unmarked, so it always exits. A rejection
exits unless a registered classifier names it. Another `unhandledRejection` listener (Vitest) is
left to decide about rejections; another `uncaughtException` listener never keeps the process up.

| Entry                     | Predicate                                                                                      | Why continuing is safe                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EPIPE`                   | `code` `EPIPE`, `syscall` `write`, unheard event                                               | Node destroys the socket or pipe, then emits on a later tick; the write that caused it has already returned.                                                  |
| `ECONNRESET`              | `code` `ECONNRESET`, `syscall` `read` or `write`, unheard event                                | A peer reset, emitted after the socket is destroyed. http's "socket hang up" has no `syscall` and still exits: its request's owner is waiting for a response. |
| `WS_CLOSED_CONNECTING`    | message "WebSocket was closed before the connection was established", no `code`, unheard event | `ws` raises it only after its owner closed a still-connecting socket, emitted on a later tick.                                                                |
| Cursor closed exec stream | rejection named `WriteIterableClosedError` with message "WritableIterable is closed"           | The SDK refuses the write as its first statement because the exec already ended; nothing was written.                                                         |

Reviewed and refused:

- `ERR_STREAM_DESTROYED`: a write to a destroyed stream reports it only to the write callback,
  so it escapes only when code rethrows or rejects it on its own path. The stdout/stderr
  [closed-pipe filter](../../packages/shared/src/closedPipe.ts) still ignores it there.
- Cursor shell spawn failures: the SDK routes a failed spawn into the exec's own stream, which
  delivers it to GOAT's Cursor adapter, so containing it could hide a GOAT failure.

## Isolate by component, not by agent

Each agent CLI is already its own OS process. Measured on the desktop runtime (Node 24.22.1):
a separate Node process costs about 60 MB RSS, and a `worker_threads` worker costs about 8 MB
with a 13 µs round trip.

- Do not add a wrapper process or a worker per agent or per thread. At 100 agents that costs
  6 GB or 830 MB for nothing.
- Pure-JS work that can hold the event loop for more than about 100 ms belongs in a fixed-size
  worker pool. Shell snapshot decoding, settlement sweeps and memory catch-up stalled the main
  thread for up to 8.3 s. Set `resourceLimits`, pass large results as transferables, and never
  load a native module in a worker: a native crash in a worker still kills the process.
- Native or crash-prone helpers (computer-use drivers, screen-run children, device hubs, pty
  hosts) run as separate processes. A helper that dies restarts with exponential backoff, and a
  circuit breaker stops restarts after repeated failures in a short window, shows why, and
  resets only when the helper reports ready.
- An in-progress agent turn is never restarted in a loop. Recovery after a server restart goes
  through [restart continuation](./server-updates.md#recovering-interrupted-threads), which is
  bounded.

## Every buffer the server holds has a bound

A server dies of its own bookkeeping more often than of its children. Every queue, buffer,
fan-out, cache and replay the server holds has an explicit byte or count limit, or pages from
SQLite. Never keep a whole transcript, log or snapshot in memory to serve it later. A slow client
gets dropped or coalesced updates; it never makes the server buffer more.

## Database pressure degrades, never kills

A saturated SQLite reader returns `ReaderAdmissionOverloadError`. That error must never end a
running turn: provider ingestion retries the read once on the writer
([readerOverloadFallback.ts](../../apps/server/src/orchestration-v2/readerOverloadFallback.ts)),
and any new read on a turn's critical path must do the same or wait within a bound. Interactive
reads take precedence over background sweeps.
