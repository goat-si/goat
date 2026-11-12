import { expect, it } from "@effect/vitest";
import { EnvironmentAuthorizationError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as Gate from "./ProviderCliGate.ts";
import * as HostSync from "./ProviderHostSync.ts";
import {
  harness,
  heldGate,
  openCodeInstance as opencode,
  pendingOpenCode as pending,
  threadScope,
} from "./ProviderHostSync.testkit.ts";

const finished = {
  kind: "started",
  sync: {
    syncId: "remote-sync",
    driver: "opencode",
    version: null,
    login: false,
    startedAt: "2026-11-12T00:00:00.000Z",
    done: true,
    hosts: [{ host: null, phase: "installed", version: "1.2.3" }],
  },
};

const direct = (check: Effect.Effect<void, EnvironmentAuthorizationError>) =>
  ({ kind: "mcp", scope: threadScope, directInstall: check }) as const;

it.effect("a thread allowed to install directly starts the sync without an approval card", () =>
  Effect.gen(function* () {
    const { state, layer } = harness({ answer: () => Effect.succeed(finished) });
    const result = yield* Effect.gen(function* () {
      const sync = yield* HostSync.ProviderHostSync;
      const started = yield* sync.sync(
        { driver: "opencode", hosts: ["box"], login: false },
        direct(Effect.void),
      );
      if (started.kind === "started") yield* sync.awaitDone(started.sync.syncId);
      return started;
    }).pipe(Effect.provide(layer));
    expect(result.kind).toBe("started");
    expect(state.handoffs).toEqual([]);
    expect(state.calls[0]?.call).toMatchObject({
      host: "box",
      tool: "goat_provider_sync",
      providersManage: true,
      arguments: { driver: "opencode", login: false },
    });
  }),
);

it.effect("a direct install whose check fails before the send sends nothing", () =>
  Effect.gen(function* () {
    const checks = yield* Ref.make(0);
    const check = Ref.updateAndGet(checks, (count) => count + 1).pipe(
      Effect.flatMap((count) =>
        count === 1
          ? Effect.void
          : Effect.fail(
              new EnvironmentAuthorizationError({
                requiredScope: "providers:manage",
                message: "The thread dropped to approvals.",
              }),
            ),
      ),
    );
    const { state, layer } = harness({ answer: () => Effect.succeed(finished) });
    const done = yield* Effect.gen(function* () {
      const sync = yield* HostSync.ProviderHostSync;
      const started = yield* sync.sync(
        { driver: "opencode", hosts: ["box"], login: false },
        direct(check),
      );
      return started.kind === "started" ? yield* sync.awaitDone(started.sync.syncId) : undefined;
    }).pipe(Effect.provide(layer));
    expect(state.calls).toEqual([]);
    expect(done?.hosts[0]).toMatchObject({
      phase: "failed",
      message: "The thread dropped to approvals.",
    });
  }),
);

/** Each probe answers the next entry; a fresh probe is recorded. */
const gate = (answers: ReadonlyArray<Gate.CliAnswer>, fresh: Array<boolean>) =>
  Effect.map(Ref.make<ReadonlyArray<Gate.CliAnswer>>(answers), (queue) =>
    Layer.succeed(
      Gate.ProviderCliGate,
      Gate.ProviderCliGate.of({
        require: () => Effect.void,
        missing: () => Effect.void.pipe(Effect.as(undefined)),
        probe: (_instanceId, options) =>
          Effect.sync(() => fresh.push(options?.fresh === true)).pipe(
            Effect.andThen(
              Ref.modify(queue, (all): readonly [Gate.CliAnswer, ReadonlyArray<Gate.CliAnswer>] => [
                all[0] ?? { kind: "unknown" },
                all.slice(1),
              ]),
            ),
          ),
      }),
    ),
  );

const installLocally = (cliGate: Layer.Layer<Gate.ProviderCliGate>) =>
  Effect.gen(function* () {
    const { state, layer } = harness({
      providers: [pending],
      instances: [{ instanceId: opencode, driverKind: "opencode" }],
      cliGate,
    });
    const done = yield* Effect.gen(function* () {
      const sync = yield* HostSync.ProviderHostSync;
      const started = yield* sync.sync(
        { driver: "opencode", version: "1.2.3", login: false },
        { kind: "client", sessionId: "person" as never },
      );
      return started.kind === "started" ? yield* sync.awaitDone(started.sync.syncId) : undefined;
    }).pipe(Effect.provide(layer));
    return { state, host: done?.hosts[0] };
  });

it.effect("a CLI its probe finds missing is installed even when the snapshot says installed", () =>
  Effect.gen(function* () {
    const fresh: Array<boolean> = [];
    const missing = { kind: "missing", provider: { ...pending, cli: "missing" } } as const;
    const present = {
      kind: "present",
      provider: { ...pending, cli: "present", version: "1.2.3" },
    } as const;
    const { state, host } = yield* installLocally(yield* gate([missing, present], fresh));
    expect(state.spawned.map((child) => child.args.join(" "))).toEqual([
      "install -g opencode-ai@1.2.3",
    ]);
    // The answer after installing comes from a probe that started after the installer.
    expect(fresh).toEqual([false, true]);
    expect(host).toMatchObject({
      phase: "installed",
      version: "1.2.3",
      ran: "npm install -g opencode-ai@1.2.3",
      login: { type: "terminal", command: "opencode auth login" },
    });
  }),
);

it.effect(
  "an install GOAT cannot confirm afterwards is reported as unconfirmed, not installed",
  () =>
    Effect.gen(function* () {
      const missing = { kind: "missing", provider: { ...pending, cli: "missing" } } as const;
      const { host } = yield* installLocally(yield* gate([missing, { kind: "unknown" }], []));
      expect(host).toMatchObject({
        phase: "failed",
        message: "Installed, but GOAT could not confirm opencode runs here.",
      });
    }),
);

it.effect.each([{ who: "thread" }, { who: "person" }] as const)(
  "regression S1-1: an install whose $who loses authority while it waits spawns nothing",
  ({ who }) =>
    Effect.gen(function* () {
      const revoked = yield* Ref.make(false);
      const probing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let personRevoked = false;
      const check = Effect.flatMap(Ref.get(revoked), (gone) =>
        gone
          ? Effect.fail(
              new EnvironmentAuthorizationError({
                requiredScope: "providers:manage",
                message: "The thread dropped to approvals.",
              }),
            )
          : Effect.void,
      );
      const { state, layer } = harness({
        providers: [pending],
        instances: [{ instanceId: opencode, driverKind: "opencode" }],
        cliGate: heldGate(probing, release),
        personScopes: () =>
          personRevoked
            ? ["orchestration:read", "orchestration:operate"]
            : ["orchestration:read", "orchestration:operate", "providers:manage"],
      });
      const host = yield* Effect.gen(function* () {
        const sync = yield* HostSync.ProviderHostSync;
        const started = yield* sync.sync(
          { driver: "opencode", version: "1.2.3", login: false },
          who === "thread" ? direct(check) : { kind: "client", sessionId: "person" as never },
        );
        if (started.kind !== "started") return expect.unreachable();
        yield* Deferred.await(probing);
        yield* Ref.set(revoked, true);
        personRevoked = true;
        yield* Deferred.succeed(release, undefined);
        return (yield* sync.awaitDone(started.sync.syncId)).hosts[0];
      }).pipe(Effect.provide(layer));
      expect(state.spawned).toEqual([]);
      expect(host).toMatchObject({ host: null, phase: "failed" });
      if (who === "thread") expect(host?.message).toBe("The thread dropped to approvals.");
    }),
);

const UNCONFIRMED =
  "Could not confirm the cancel on box; its installer may still be running. Check goat_provider_host_matrix.";
const remoteSync = (done: boolean, host: Record<string, unknown>) => ({
  ...finished.sync,
  done,
  hosts: [{ host: null, version: null, ...host }],
});
const dropped = new Dispatch.SshRemoteDispatchError({
  reason: "host_unavailable",
  message: "box went away",
});

it.effect.each([
  {
    remote: "confirms",
    reply: Effect.succeed(remoteSync(true, { phase: "cancelled" })),
    host: { phase: "cancelled" },
  },
  { remote: "fails", reply: Effect.fail(dropped), host: { phase: "failed", message: UNCONFIRMED } },
  {
    remote: "is still installing",
    reply: Effect.succeed(remoteSync(false, { phase: "installing" })),
    host: { phase: "failed", message: UNCONFIRMED },
  },
  {
    remote: "answers unreadably",
    reply: Effect.succeed({ nope: true }),
    host: { phase: "failed", message: UNCONFIRMED },
  },
  {
    remote: "had already installed",
    reply: Effect.succeed(remoteSync(true, { phase: "installed", version: "1.2.3" })),
    host: { phase: "installed", version: "1.2.3" },
  },
  {
    remote: "had already failed",
    reply: Effect.succeed(remoteSync(true, { phase: "failed", message: "npm exited 1." })),
    host: { phase: "failed", message: "npm exited 1." },
  },
] as const)(
  "regression S1-2/S2-3: cancelling a direct remote install that $remote reads what the remote confirmed",
  ({ reply, host }) =>
    Effect.gen(function* () {
      const accepted = yield* Deferred.make<void>();
      const { state, layer } = harness({
        answer: (call) =>
          call.tool === "goat_provider_sync"
            ? Deferred.succeed(accepted, undefined).pipe(
                Effect.as({ kind: "started", sync: remoteSync(false, { phase: "installing" }) }),
              )
            : reply,
      });
      yield* Effect.gen(function* () {
        const sync = yield* HostSync.ProviderHostSync;
        const started = yield* sync.sync(
          { driver: "opencode", hosts: ["box"], login: false },
          direct(Effect.void),
        );
        if (started.kind !== "started") return expect.unreachable();
        yield* Deferred.await(accepted);
        // The cancel handler builds its own caller, which carries no install check.
        const cancelled = yield* sync.cancel(
          { syncId: started.sync.syncId },
          { kind: "mcp", scope: threadScope },
        );
        expect(state.calls.map(({ call }) => call.tool)).toEqual([
          "goat_provider_sync",
          "goat_provider_sync_cancel",
        ]);
        expect(cancelled.hosts[0]).toEqual({ host: "box", version: null, ...host });
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each([
  {
    start: "times out after the remote may have accepted it",
    error: dropped,
    host: { phase: "failed", message: UNCONFIRMED },
  },
  {
    // The bridge reports a reply without its JSON-RPC envelope this way, after the call was sent.
    start: "gets an unreadable reply after it was sent",
    error: new Dispatch.SshRemoteDispatchError({
      reason: "remote_refused",
      message: "GOAT on box could not run goat_provider_sync: protocol error",
    }),
    host: { phase: "failed", message: UNCONFIRMED },
  },
  {
    // The wire does not say whether a structured error came before or after the sync started.
    start: "gets a structured error from the remote's tool",
    error: new Dispatch.SshRemoteDispatchError({
      reason: "remote_refused",
      message: "The remote goat_provider_sync refused: outcome unknown",
      remoteCode: "orchestration_error",
    }),
    host: { phase: "failed", message: UNCONFIRMED },
  },
  {
    // "Unknown tool" also arrives as an RPC error after the call was sent.
    start: "answers that the remote has no such tool",
    error: new Dispatch.SshRemoteDispatchError({
      reason: "remote_outdated",
      message: "GOAT on box does not have goat_provider_sync; update GOAT on box.",
    }),
    host: { phase: "failed", message: UNCONFIRMED },
  },
  {
    start: "never left because the host is unknown here",
    error: new Dispatch.SshRemoteDispatchError({
      reason: "host_unknown",
      message: "box is unknown",
    }),
    host: { phase: "cancelled" },
  },
] as const)(
  "regression S2-2: a cancel waiting on a start that $start says only what it knows",
  ({ error, host }) =>
    Effect.gen(function* () {
      const calling = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { state, layer } = harness({
        answer: () =>
          Deferred.succeed(calling, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.fail(error)),
          ),
      });
      yield* Effect.gen(function* () {
        const sync = yield* HostSync.ProviderHostSync;
        const started = yield* sync.sync(
          { driver: "opencode", hosts: ["box"], login: false },
          direct(Effect.void),
        );
        if (started.kind !== "started") return expect.unreachable();
        yield* Deferred.await(calling);
        const stopping = yield* sync
          .cancel({ syncId: started.sync.syncId }, { kind: "mcp", scope: threadScope })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        const cancelled = yield* Fiber.join(stopping);
        // No remote sync id came back, so there is nothing to cancel there.
        expect(state.calls.map(({ call }) => call.tool)).toEqual(["goat_provider_sync"]);
        expect(cancelled.hosts[0]).toEqual({ host: "box", version: null, ...host });
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "regression S3-2: awaitDone during a held remote cancel waits for what the remote says",
  () =>
    Effect.gen(function* () {
      const accepted = yield* Deferred.make<void>();
      const cancelling = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { layer } = harness({
        answer: (call) =>
          call.tool === "goat_provider_sync"
            ? Deferred.succeed(accepted, undefined).pipe(
                Effect.as({ kind: "started", sync: remoteSync(false, { phase: "installing" }) }),
              )
            : Deferred.succeed(cancelling, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(remoteSync(true, { phase: "cancelled" })),
              ),
      });
      yield* Effect.gen(function* () {
        const sync = yield* HostSync.ProviderHostSync;
        const started = yield* sync.sync(
          { driver: "opencode", hosts: ["box"], login: false },
          direct(Effect.void),
        );
        if (started.kind !== "started") return expect.unreachable();
        yield* Deferred.await(accepted);
        const stopping = yield* sync
          .cancel({ syncId: started.sync.syncId }, { kind: "mcp", scope: threadScope })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(cancelling);
        const waiting = yield* sync
          .awaitDone(started.sync.syncId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
        expect(yield* Fiber.join(waiting)).toMatchObject({
          done: true,
          hosts: [{ host: "box", phase: "cancelled" }],
        });
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "regression S4-1: a cancel whose caller goes away while a host stops still finishes it",
  () =>
    Effect.gen(function* () {
      const running = {
        started: yield* Deferred.make<void>(),
        killing: yield* Deferred.make<void>(),
        killed: yield* Deferred.make<void>(),
      };
      const missing = { kind: "missing", provider: { ...pending, cli: "missing" } } as const;
      const person = { kind: "client", sessionId: "person" as never } as const;
      const { layer } = harness({
        providers: [pending],
        instances: [{ instanceId: opencode, driverKind: "opencode" }],
        cliGate: yield* gate([missing], []),
        running,
      });
      yield* Effect.gen(function* () {
        const sync = yield* HostSync.ProviderHostSync;
        const started = yield* sync.sync(
          { driver: "opencode", version: "1.2.3", login: false },
          person,
        );
        if (started.kind !== "started") return expect.unreachable();
        yield* Deferred.await(running.started);
        const stopping = yield* sync
          .cancel({ syncId: started.sync.syncId }, person)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(running.killing);
        yield* Fiber.interrupt(stopping);
        yield* Deferred.succeed(running.killed, undefined);
        expect(yield* sync.awaitDone(started.sync.syncId)).toMatchObject({
          done: true,
          hosts: [{ host: null, phase: "cancelled" }],
        });
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("regression S4-2: two cancels of one sync share one remote cancel and one result", () =>
  Effect.gen(function* () {
    const accepted = yield* Deferred.make<void>();
    const cancelling = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let cancels = 0;
    const { state, layer } = harness({
      answer: (call) =>
        call.tool === "goat_provider_sync"
          ? Deferred.succeed(accepted, undefined).pipe(
              Effect.as({ kind: "started", sync: remoteSync(false, { phase: "installing" }) }),
            )
          : (cancels += 1) === 1
            ? Deferred.succeed(cancelling, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(remoteSync(true, { phase: "cancelled" })),
              )
            : Effect.succeed(remoteSync(false, { phase: "installing" })),
    });
    yield* Effect.gen(function* () {
      const sync = yield* HostSync.ProviderHostSync;
      const started = yield* sync.sync(
        { driver: "opencode", hosts: ["box"], login: false },
        direct(Effect.void),
      );
      if (started.kind !== "started") return expect.unreachable();
      yield* Deferred.await(accepted);
      const cancel = sync.cancel(
        { syncId: started.sync.syncId },
        { kind: "mcp", scope: threadScope },
      );
      const first = yield* cancel.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(cancelling);
      const second = yield* cancel.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      const answers = [yield* Fiber.join(first), yield* Fiber.join(second)];
      const settled = yield* sync.awaitDone(started.sync.syncId);
      expect(
        state.calls.filter(({ call }) => call.tool === "goat_provider_sync_cancel"),
      ).toHaveLength(1);
      for (const answer of [...answers, settled])
        expect(answer.hosts).toEqual([{ host: "box", phase: "cancelled", version: null }]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("regression S6-1: a remote install Home lost track of can still be cancelled there", () =>
  Effect.gen(function* () {
    const { state, layer } = harness({
      answer: (call) =>
        call.tool === "goat_provider_sync"
          ? Effect.succeed({ kind: "started", sync: remoteSync(false, { phase: "installing" }) })
          : call.tool === "goat_provider_sync_status"
            ? Effect.fail(dropped)
            : Effect.succeed(remoteSync(true, { phase: "cancelled" })),
    });
    yield* Effect.gen(function* () {
      const sync = yield* HostSync.ProviderHostSync;
      const started = yield* sync.sync(
        { driver: "opencode", hosts: ["box"], login: false },
        direct(Effect.void),
      );
      if (started.kind !== "started") return expect.unreachable();
      yield* TestClock.adjust("1 minute");
      const lost = yield* sync.awaitDone(started.sync.syncId);
      expect(lost.hosts[0]).toMatchObject({ host: "box", phase: "failed" });
      expect(lost.hosts[0]?.message).toContain("may still be running");
      const cancelled = yield* sync.cancel(
        { syncId: started.sync.syncId },
        { kind: "client", sessionId: "person" as never },
      );
      expect(state.calls.at(-1)?.call).toMatchObject({
        tool: "goat_provider_sync_cancel",
        arguments: { syncId: "remote-sync" },
      });
      expect(cancelled.hosts[0]).toEqual({ host: "box", phase: "cancelled", version: null });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "regression S7-1: awaitDone waits for a retried cancel of a host Home lost track of",
  () =>
    Effect.gen(function* () {
      const cancelling = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { layer } = harness({
        answer: (call) =>
          call.tool === "goat_provider_sync"
            ? Effect.succeed({ kind: "started", sync: remoteSync(false, { phase: "installing" }) })
            : call.tool === "goat_provider_sync_status"
              ? Effect.fail(dropped)
              : Deferred.succeed(cancelling, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(remoteSync(true, { phase: "cancelled" })),
                ),
      });
      yield* Effect.gen(function* () {
        const sync = yield* HostSync.ProviderHostSync;
        const started = yield* sync.sync(
          { driver: "opencode", hosts: ["box"], login: false },
          direct(Effect.void),
        );
        if (started.kind !== "started") return expect.unreachable();
        yield* TestClock.adjust("1 minute");
        yield* sync.awaitDone(started.sync.syncId);
        const stopping = yield* sync
          .cancel({ syncId: started.sync.syncId }, { kind: "client", sessionId: "person" as never })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(cancelling);
        const waiting = yield* sync
          .awaitDone(started.sync.syncId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
        expect(yield* Fiber.join(waiting)).toMatchObject({
          done: true,
          hosts: [{ host: "box", phase: "cancelled" }],
        });
      }).pipe(Effect.provide(layer));
    }),
);
