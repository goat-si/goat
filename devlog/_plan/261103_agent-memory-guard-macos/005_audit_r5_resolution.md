# 005 — Audit round 5 resolution (amends 004)

## B1 batch reap — decision block runs only in the check phase

Confirmed: libuv 1.52.1 (Node v26.12.1 here) `uv__wait_children` first reaps every exited child into a pending queue,
then runs each exit callback; Node drains microtasks after each callback, so code resumed by a microtask can run while a
later child of the batch is reaped but not yet reported.

Fix: the synchronous decision-and-signal block runs inside a `setImmediate` callback, not in an Effect continuation:

```ts
// Reaping happens only in libuv's poll phase and finishes every exit callback of the batch before the phase ends,
// so inside a check-phase callback a handle that says running has not been reaped and still owns its PID.
const inCheckPhase = <A>(block: () => A) =>
  Effect.callback<A>((resume) => {
    const id = setImmediate(() => resume(Effect.succeed(block())));
    return Effect.sync(() => clearImmediate(id));
  });
```

`uv__wait_children` is called from `uv__io_poll` (kqueue.c:289/407 for EVFILT_PROC and the signal path) and returns
only after every pending exit callback ran; the check phase runs after `uv__io_poll` returns and reaps nothing. So for
every child, inside the check callback: reaped ⇔ Node ran onexit ⇔ `exitCode/signalCode` set and the effect spawner's
exit Deferred completed (its 'exit' listener runs synchronously from onexit). The ps sample is gathered before, in normal
Effect code; only the liveness check and the signals live in the block.

Test: guard tests inject `inCheckPhase` as a dependency (identity in TestClock tests). The it.live contract test uses
one child: `isRunning()` is true before exit and false inside the child's own 'exit' listener and inside an
`inCheckPhase` block scheduled from it (both adapters: Node ChildProcess and effect handle). The batch-reap ordering is
carried by the libuv source argument above (round 6 confirmed it for libuv 1.52.1 kqueue), stated in a code comment
with the condition that the same Node loop owns and reaps the child.

## B2 mark ordering

Block: `isRunning()` → kill(pid) in try; on success mark immediately; then kill(-pid) in its own try (errors logged as a
partial kill). Test: group signal throws → thread still marked.

## B3 spawn-site table corrections

- ACP: watch every spawned ACP child (wrap or shell launch), owned, `threadId` from AgentScopeThreadId.
- Muse: not watched in this PR. The SDK keeps the Node child behind a private transport; exposing it is an SDK change.
  Recorded in the PR as a gap.
- Pi: the adapter passes `threadId` into its RPC spawn options so rpc.ts can watch the handle.

