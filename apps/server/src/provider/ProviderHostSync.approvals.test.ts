import { expect, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  HandoffError,
  type HandoffReadInput,
  type ProviderSyncInput,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import type * as Handoffs from "../handoffs/Handoffs.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { durableHandoffs, threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HostSync from "./ProviderHostSync.ts";
import {
  type Call,
  environmentId,
  harness,
  person,
  session,
  threadScope,
  viewer,
} from "./ProviderHostSync.testkit.ts";

const FULL: ReadonlyArray<AuthEnvironmentScope> = [
  "orchestration:read",
  "orchestration:operate",
  "providers:manage",
];
const agent = {
  kind: "mcp",
  scope: { ...threadScope, thread: { ...threadScope.thread!, threadId } },
} as const;
const RESTARTED =
  "GOAT restarted on this machine before this host finished. Call goat_provider_host_matrix to see its state.";

const finishedRemote = {
  kind: "started",
  sync: {
    syncId: "remote-sync",
    driver: "opencode",
    version: "1.2.3",
    login: true,
    startedAt: "2026-10-20T00:00:00.000Z",
    done: true,
    hosts: [
      {
        host: null,
        phase: "installed",
        version: "1.2.3",
        login: { type: "terminal", command: "opencode auth login" },
      },
    ],
  },
};
/** The remote host finishes its sync at once, or when `gate` opens. */
const remote =
  (gate?: Deferred.Deferred<void>) =>
  (call: Call): Effect.Effect<unknown, Dispatch.SshRemoteDispatchError> =>
    call.tool === "goat_provider_sync"
      ? (gate === undefined ? Effect.void : Deferred.await(gate)).pipe(Effect.as(finishedRemote))
      : Effect.die(`unexpected remote call ${call.tool}`);

type Service = HostSync.ProviderHostSync["Service"];
type Wrap = (handoffs: Handoffs.Handoffs["Service"]) => Handoffs.Handoffs["Service"];

/**
 * One persisted handoff store shared by every `boot`. Each boot is a server process: its own
 * Handoffs and ProviderHostSync, whose forked work stops when the boot's body returns.
 */
const makeServers = (orchestrator: Orchestrator.OrchestratorV2["Service"]) =>
  Effect.gen(function* () {
    let personScopes = FULL;
    let calls = 0;
    const sessions = DateTime.now.pipe(
      Effect.map((now) => [
        session(person, personScopes, now),
        session(viewer, ["orchestration:read", "orchestration:operate"], now),
      ]),
    );
    const durable = yield* durableHandoffs(orchestrator, { environmentId, sessions });
    const boot = <B, F>(
      options: {
        readonly answer?: (call: Call) => Effect.Effect<unknown, Dispatch.SshRemoteDispatchError>;
        readonly wrap?: Wrap;
        readonly providersBroken?: boolean;
      },
      run: (sync: Service, handoffs: Handoffs.Handoffs["Service"]) => Effect.Effect<B, F>,
    ) =>
      Effect.gen(function* () {
        const real = yield* durable.start;
        const handoffs = options.wrap === undefined ? real : options.wrap(real);
        const answer = options.answer ?? remote();
        const { layer } = harness({
          answer: (call) => Effect.suspend(() => ((calls += 1), answer(call))),
          handoffs,
          ...(options.providersBroken === true ? { providersBroken: true } : {}),
          personScopes: () => personScopes,
          snapshot: (id) =>
            orchestrator
              .getThreadProjection(id)
              .pipe(Effect.map((projection) => ({ projection }) as never)),
        });
        return yield* HostSync.ProviderHostSync.pipe(
          Effect.flatMap((sync) => run(sync, handoffs)),
          Effect.provide(layer),
        );
      });
    return {
      boot,
      remoteCalls: () => calls,
      revoke: () => {
        personScopes = ["orchestration:read", "orchestration:operate"];
      },
    };
  });
type Servers = Effect.Success<ReturnType<typeof makeServers>>;
const servers = <A, E, R>(body: (servers: Servers) => Effect.Effect<A, E, R>) =>
  withHarness(({ orchestrator }) => makeServers(orchestrator).pipe(Effect.flatMap(body)));

const ask = (sync: Service, input: Partial<ProviderSyncInput> = {}) =>
  sync.sync({ driver: "opencode", hosts: ["box"], version: "1.2.3", ...input }, agent).pipe(
    Effect.map((result): HandoffReadInput => {
      if (result.kind !== "needs_human") throw new Error("expected an approval");
      return { threadId, handoffId: result.handoff.handoffId };
    }),
  );
const approve = (sync: Service, address: HandoffReadInput, by = person) =>
  sync.respondHandoff({ ...address, action: "completed" }, by);
const statusOf = (sync: Service, address: HandoffReadInput) =>
  sync.status({ handoffId: address.handoffId }, agent);

it.effect("asks a person before an agent's sync touches any host, then runs it once as them", () =>
  servers(({ boot, remoteCalls }) =>
    boot({}, (sync) =>
      Effect.gen(function* () {
        const address = yield* ask(sync);
        expect(remoteCalls()).toBe(0);
        expect(Exit.isFailure(yield* Effect.exit(approve(sync, address, viewer)))).toBe(true);

        // Two clicks racing: exactly one starts the sync, and a later click starts nothing.
        const raced = yield* Effect.all(
          [Effect.exit(approve(sync, address)), Effect.exit(approve(sync, address))],
          { concurrency: "unbounded" },
        );
        expect(raced.filter(Exit.isSuccess)).toHaveLength(1);
        expect(Exit.isFailure(yield* Effect.exit(approve(sync, address)))).toBe(true);

        const followed = yield* statusOf(sync, address);
        const finished = yield* sync.awaitDone(followed.syncId);
        expect(finished.hosts).toEqual([
          {
            host: "box",
            phase: "installed",
            version: "1.2.3",
            login: { type: "terminal", command: "opencode auth login" },
          },
        ]);
        const bystander = yield* sync.status(
          { syncId: followed.syncId },
          { kind: "client", sessionId: viewer },
        );
        expect(bystander.hosts[0]).not.toHaveProperty("login");
        const stop = sync.cancel(
          { syncId: followed.syncId },
          { kind: "client", sessionId: viewer },
        );
        expect(Exit.isFailure(yield* Effect.exit(stop))).toBe(true);
        // Another thread holds no approval with this id.
        const stranger = {
          kind: "mcp",
          scope: {
            ...agent.scope,
            thread: { ...agent.scope.thread, threadId: ThreadId.make("x") },
          },
        } as const;
        const foreign = sync.status({ handoffId: address.handoffId }, stranger);
        expect(yield* Effect.flip(foreign)).toMatchObject({ code: "not_found" });
      }),
    ).pipe(Effect.tap(() => Effect.sync(() => expect(remoteCalls()).toBe(1)))),
  ),
);

it.effect("answers status for an approval that started no sync with how it ended", () =>
  servers(({ boot }) =>
    Effect.gen(function* () {
      yield* boot({}, (sync, handoffs) =>
        Effect.gen(function* () {
          const failure = (address: HandoffReadInput) => statusOf(sync, address).pipe(Effect.flip);
          const declined = yield* ask(sync, { version: "1.0.0" });
          expect(yield* failure(declined)).toMatchObject({
            code: "not_found",
            detail: /not started a sync yet/,
          });
          yield* sync.respondHandoff({ ...declined, action: "declined" }, person);
          expect(yield* failure(declined)).toMatchObject({ code: "declined" });

          const cancelled = yield* ask(sync, { version: "1.0.1" });
          yield* sync.respondHandoff({ ...cancelled, action: "cancelled" }, person);
          expect(yield* failure(cancelled)).toMatchObject({ code: "cancelled" });

          const expired = yield* ask(sync, { version: "1.0.2" });
          yield* TestClock.adjust("16 minutes");
          yield* handoffs.sweep;
          expect(yield* failure(expired)).toMatchObject({ code: "expired" });
        }),
      );
      // Approved, but the sync cannot start: status says so instead of "not started yet".
      yield* boot({ providersBroken: true }, (sync) =>
        Effect.gen(function* () {
          const address = yield* ask(sync);
          yield* approve(sync, address);
          expect(yield* statusOf(sync, address).pipe(Effect.flip)).toMatchObject({
            code: "start_failed",
            detail:
              "The person approved this sync, but it did not start: an unexpected error stopped it.",
          });
        }),
      );
    }),
  ),
);

it.effect(
  "starts an approval asked before a restart, once, when the person approves after it",
  () =>
    servers(({ boot, remoteCalls }) =>
      Effect.gen(function* () {
        const address = yield* boot({}, (sync) => ask(sync));
        yield* boot({}, (sync) =>
          Effect.gen(function* () {
            yield* approve(sync, address);
            const followed = yield* statusOf(sync, address);
            expect((yield* sync.awaitDone(followed.syncId)).done).toBe(true);
            yield* sync.resumeApprovals;
          }),
        );
        expect(remoteCalls()).toBe(1);
      }),
    ),
);

it.effect("reads a sync a restart interrupted as failed by its approval, and never reruns it", () =>
  servers(({ boot, remoteCalls }) =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      const address = yield* boot({ answer: remote(never) }, (sync) =>
        Effect.gen(function* () {
          const address = yield* ask(sync);
          yield* approve(sync, address);
          expect((yield* statusOf(sync, address)).done).toBe(false);
          return address;
        }),
      );
      yield* boot({}, (sync) =>
        Effect.gen(function* () {
          yield* sync.resumeApprovals;
          yield* sync.resumeApprovals;
          const after = yield* statusOf(sync, address);
          expect(after.done).toBe(true);
          expect(after.hosts).toEqual([
            { host: "box", phase: "failed", version: null, message: RESTARTED },
          ]);
        }),
      );
      expect(remoteCalls()).toBe(1);
    }),
  ),
);

it.effect(
  "starts an approval a stop left unstarted on resume, once, while fresh and authorized",
  () =>
    servers(({ boot, remoteCalls, revoke }) =>
      Effect.gen(function* () {
        // The person answered, then the server stopped before the sync started.
        const answeredThenStopped = (version: string) =>
          boot({}, (sync, handoffs) =>
            ask(sync, { version }).pipe(
              Effect.tap((address) =>
                handoffs.respond({ ...address, action: "completed" }, person),
              ),
            ),
          );
        const resumeThen = <B, F>(read: (sync: Service) => Effect.Effect<B, F>) =>
          boot({}, (sync) => sync.resumeApprovals.pipe(Effect.andThen(read(sync))));

        const unstarted = yield* answeredThenStopped("1.0.0");
        yield* boot({}, (sync) =>
          Effect.gen(function* () {
            yield* Effect.all([sync.resumeApprovals, sync.resumeApprovals]);
            yield* sync.awaitDone((yield* statusOf(sync, unstarted)).syncId);
          }),
        );
        expect(remoteCalls()).toBe(1);

        const stale = yield* answeredThenStopped("1.0.1");
        yield* TestClock.adjust("16 minutes");
        const tooOld = yield* resumeThen((sync) => statusOf(sync, stale).pipe(Effect.flip));
        expect(tooOld).toMatchObject({ code: "start_failed", detail: /too old to start/ });

        const revoked = yield* answeredThenStopped("1.0.2");
        revoke();
        const refused = yield* resumeThen((sync) => statusOf(sync, revoked).pipe(Effect.flip));
        expect(refused).toMatchObject({ code: "start_failed", detail: /did not start/ });
        expect(remoteCalls()).toBe(1);
      }),
    ),
);

it.effect("keeps a finished sync's per-host result after a restart, without sign-in codes", () =>
  servers(({ boot }) =>
    Effect.gen(function* () {
      const address = yield* boot({}, (sync) =>
        Effect.gen(function* () {
          const address = yield* ask(sync);
          yield* approve(sync, address);
          yield* sync.awaitDone((yield* statusOf(sync, address)).syncId);
          return address;
        }),
      );
      const after = yield* boot({}, (sync) =>
        sync.resumeApprovals.pipe(Effect.andThen(statusOf(sync, address))),
      );
      expect(after).toMatchObject({ done: true, driver: "opencode" });
      expect(after.hosts).toEqual([{ host: "box", phase: "installed", version: "1.2.3" }]);
      expect(JSON.stringify(after)).not.toContain("auth login");
    }),
  ),
);

it.effect("records the result for every approval that joins one running sync", () =>
  servers(({ boot, remoteCalls }) =>
    Effect.gen(function* () {
      const remoteGate = yield* Deferred.make<void>();
      const writeGate = yield* Deferred.make<void>();
      const joinedWrite = yield* Deferred.make<void>();
      let second: string | undefined;
      // The second approval's syncId write waits until the shared sync has finished.
      const wrap: Wrap = (handoffs) => ({
        ...handoffs,
        recordProviderProgress: (address, progress) =>
          (address.handoffId === second &&
          typeof progress === "object" &&
          progress !== null &&
          "syncId" in progress
            ? Deferred.succeed(joinedWrite, undefined).pipe(
                Effect.andThen(Deferred.await(writeGate)),
              )
            : Effect.void
          ).pipe(Effect.andThen(handoffs.recordProviderProgress(address, progress))),
      });
      const [first, joined] = yield* boot({ answer: remote(remoteGate), wrap }, (sync) =>
        Effect.gen(function* () {
          const first = yield* ask(sync, { version: "latest" });
          // Same driver, hosts and resolved version, so it joins the first sync.
          const joined = yield* ask(sync, { version: undefined });
          second = joined.handoffId;
          yield* approve(sync, first);
          const approving = yield* Effect.forkChild(approve(sync, joined));
          // It has joined the running sync and now waits to record that.
          yield* Deferred.await(joinedWrite);
          const { syncId } = yield* statusOf(sync, first);
          yield* Deferred.succeed(remoteGate, undefined);
          yield* sync.awaitDone(syncId);
          yield* Deferred.succeed(writeGate, undefined);
          yield* Fiber.join(approving);
          return [first, joined] as const;
        }),
      );
      yield* boot({}, (sync) =>
        Effect.forEach([first, joined], (address) =>
          statusOf(sync, address).pipe(
            Effect.tap((state) =>
              Effect.sync(() =>
                expect(state).toMatchObject({ done: true, hosts: [{ phase: "installed" }] }),
              ),
            ),
          ),
        ),
      );
      expect(remoteCalls()).toBe(1);
    }),
  ),
);

it.effect("neither loses a running sync nor starts it twice when a progress write fails", () =>
  servers(({ boot, remoteCalls }) =>
    Effect.gen(function* () {
      const firstGate = yield* Deferred.make<void>();
      const secondGate = yield* Deferred.make<void>();
      const answer = (call: Call) =>
        remote(call.arguments.version === "2.0.0" ? secondGate : firstGate)(call);
      let refuse: "starting" | "syncId" | undefined = "starting";
      const wrap: Wrap = (handoffs) => ({
        ...handoffs,
        recordProviderProgress: (address, progress) =>
          refuse !== undefined &&
          typeof progress === "object" &&
          progress !== null &&
          refuse in progress
            ? Effect.fail(new HandoffError({ reason: "unavailable" }))
            : handoffs.recordProviderProgress(address, progress),
      });
      const running = yield* boot({ answer, wrap }, (sync) =>
        Effect.gen(function* () {
          // The intent write fails: nothing starts, and the next resume starts it once.
          const address = yield* ask(sync);
          yield* approve(sync, address);
          expect(remoteCalls()).toBe(0);
          refuse = undefined;
          yield* sync.resumeApprovals;
          yield* sync.resumeApprovals;
          const { syncId } = yield* statusOf(sync, address);
          yield* Deferred.succeed(firstGate, undefined);
          yield* sync.awaitDone(syncId);

          // The syncId write fails: resume leaves the running sync alone, and it still settles.
          refuse = "syncId";
          const running = yield* ask(sync, { version: "2.0.0" });
          yield* approve(sync, running);
          yield* sync.resumeApprovals;
          const live = yield* statusOf(sync, running);
          expect(live.done).toBe(false);
          yield* Deferred.succeed(secondGate, undefined);
          yield* sync.awaitDone(live.syncId);
          return running;
        }),
      );
      const settled = yield* boot({}, (sync) => statusOf(sync, running));
      expect(settled).toMatchObject({ done: true, hosts: [{ phase: "installed" }] });
      expect(remoteCalls()).toBe(2);
    }),
  ),
);

it.effect(
  "launches the sync whose start it recorded even when the approving request is interrupted",
  () =>
    servers(({ boot, remoteCalls }) =>
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const intentGate = yield* Deferred.make<void>();
        const remoteGate = yield* Deferred.make<void>();
        const wrap: Wrap = (handoffs) => ({
          ...handoffs,
          recordProviderProgress: (address, progress) =>
            (typeof progress === "object" && progress !== null && "starting" in progress
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(intentGate)),
                )
              : Effect.void
            ).pipe(Effect.andThen(handoffs.recordProviderProgress(address, progress))),
        });
        yield* boot({ answer: remote(remoteGate), wrap }, (sync) =>
          Effect.gen(function* () {
            const address = yield* ask(sync, { hosts: ["box", "spare"] });
            const approving = yield* Effect.forkChild(approve(sync, address));
            yield* Deferred.await(reached);
            const interrupting = yield* Effect.forkChild(Fiber.interrupt(approving));
            yield* Deferred.succeed(intentGate, undefined);
            yield* Fiber.join(interrupting);
            // Running here, so resume neither settles it as interrupted nor starts it again.
            yield* sync.resumeApprovals;
            const { syncId, done } = yield* statusOf(sync, address);
            expect(done).toBe(false);
            yield* Deferred.succeed(remoteGate, undefined);
            const finished = yield* sync.awaitDone(syncId);
            expect(finished.hosts.map((host) => [host.host, host.phase])).toEqual([
              ["box", "installed"],
              ["spare", "installed"],
            ]);
          }),
        );
        expect(remoteCalls()).toBe(2);
      }),
    ),
);

it.effect(
  "settles a start a stop left only as recorded intent as may have run, and never runs it",
  () =>
    servers(({ boot, remoteCalls }) =>
      Effect.gen(function* () {
        // The server stopped after recording the intent and before registering the sync.
        const address = yield* boot({}, (sync, handoffs) =>
          Effect.gen(function* () {
            const address = yield* ask(sync);
            yield* handoffs.respond({ ...address, action: "completed" }, person);
            yield* handoffs.recordProviderProgress(address, { starting: true });
            return address;
          }),
        );
        const failure = yield* boot({}, (sync) =>
          Effect.gen(function* () {
            yield* sync.resumeApprovals;
            yield* sync.resumeApprovals;
            return yield* Effect.flip(statusOf(sync, address));
          }),
        );
        expect(failure).toMatchObject({ code: "start_failed", detail: /may have run/ });
        expect(remoteCalls()).toBe(0);
      }),
    ),
);

it.effect("retries a finished sync's result that could not be written, so a restart keeps it", () =>
  servers(({ boot }) =>
    Effect.gen(function* () {
      let refuse = true;
      const wrap: Wrap = (handoffs) => ({
        ...handoffs,
        finishProviderContinuation: (address, progress) =>
          refuse && typeof progress === "object" && progress !== null && "result" in progress
            ? Effect.sync(() => void (refuse = false)).pipe(
                Effect.andThen(Effect.fail(new HandoffError({ reason: "unavailable" }))),
              )
            : handoffs.finishProviderContinuation(address, progress),
      });
      const address = yield* boot({ wrap }, (sync) =>
        Effect.gen(function* () {
          const address = yield* ask(sync);
          yield* approve(sync, address);
          yield* sync.awaitDone((yield* statusOf(sync, address)).syncId);
          yield* sync.resumeApprovals;
          return address;
        }),
      );
      const after = yield* boot({}, (sync) => statusOf(sync, address));
      expect(after).toMatchObject({ done: true, hosts: [{ host: "box", phase: "installed" }] });
    }),
  ),
);
