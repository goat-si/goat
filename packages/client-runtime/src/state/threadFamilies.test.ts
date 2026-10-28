import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetShellSnapshotError,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import { createRemoteLauncherFamilies } from "../../../../apps/web/src/components/sidebar/remoteLauncherFamilies.ts";
import { foldLaunchedThreads } from "../../../../apps/web/src/components/sidebar/launchFold.ts";
import { projectSettledLaunchShelf } from "../../../../apps/web/src/components/sidebar/settledLaunchShelf.ts";
import { foldsUnderLauncher } from "@goat/shared/threadLaunchState";
import { scoreThreadSearch } from "@goat/shared/paletteSearch";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import {
  settledShelfFrontier,
  isListedSettledThread,
  unloadedOlderSettledCount,
  wantedOlderSettledPages,
} from "./olderSettledThreads.ts";
import { threadSearchSubject } from "./threadSearch.ts";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "./shell.ts";
import {
  createThreadFamilyAtoms,
  threadFamilyRead,
  threadFamilyRowsMissingFromShell,
} from "./threadFamilies.ts";

const row = (id: string, title = id) =>
  ({ id: ThreadId.make(id), title }) as unknown as OrchestrationV2ThreadShell;

describe("threadFamilyRowsMissingFromShell", () => {
  it("adds only the rows the shell left out, once, with shell rows winning", () => {
    const missing = threadFamilyRowsMissingFromShell({
      shellThreads: [row("parent"), row("live", "live from shell")],
      families: [
        { snapshotSequence: 4, threads: [row("live", "stale family copy"), row("idle")] },
        { snapshotSequence: 4, threads: [row("idle"), row("other")] },
      ],
      removedAt: new Map(),
    });
    expect(missing.map((thread) => thread.id)).toEqual(["idle", "other"]);
  });

  it("drops a family copy read before the shell removed that thread", () => {
    const missing = threadFamilyRowsMissingFromShell({
      shellThreads: [],
      families: [
        {
          snapshotSequence: 5,
          threads: [row("archived-after-read"), row("removed-before-read")],
        },
      ],
      removedAt: new Map([
        [ThreadId.make("archived-after-read"), 7],
        [ThreadId.make("removed-before-read"), 3],
      ]),
    });
    expect(missing.map((thread) => thread.id)).toEqual(["removed-before-read"]);
  });
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-family"),
  label: "Family environment",
  httpBaseUrl: "https://family.example.test",
  wsBaseUrl: "wss://family.example.test",
});

describe("createThreadFamilyAtoms", () => {
  it("merges mounted rows behind shell rows until released", () => {
    const runtime = Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        {} as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"],
      ),
    );
    const shellState = Atom.make<AsyncResult.AsyncResult<EnvironmentShellState>>(
      AsyncResult.success<EnvironmentShellState>({
        ...EMPTY_SHELL_STATE,
        status: "live",
        generation: 1,
        snapshot: Option.some({
          schemaVersion: 1,
          snapshotSequence: 9,
          projects: [],
          threads: [row("kept")],
          archivedThreads: [],
          olderSettled: { before: "2026-10-01T00:00:00.000Z", asOfSequence: 4, counts: [] },
        } as OrchestrationV2ShellSnapshot),
        removedAt: new Map([[ThreadId.make("removed"), 9]]),
      }),
    );
    const families = createThreadFamilyAtoms(runtime, () => shellState);
    const registry = AtomRegistry.make();
    const merged = () => registry.get(families.snapshotAtom(TARGET.environmentId))?.threads;
    registry.mount(families.snapshotAtom(TARGET.environmentId));
    // A settled shelf page read at sequence 5: the shell's copy wins, a later removal drops a row.
    const page = Atom.make<ReadonlyArray<OrchestrationV2ThreadFamily>>([
      { snapshotSequence: 5, threads: [row("kept", "page copy"), row("old"), row("removed")] },
      // Read before the latest authoritative snapshot (sequence 4), whose removals it cleared.
      { snapshotSequence: 3, threads: [row("stale-search-row")] },
    ]);
    const release = families.mountRows(registry, TARGET.environmentId, "older-settled:page", page);
    expect(merged()?.map(({ id, title }) => [id, title])).toEqual([
      ["kept", "kept"],
      ["old", "old"],
    ]);
    release();
    expect(merged()?.map(({ id }) => id)).toEqual(["kept"]);
    registry.dispose();
  });

  it.effect("reads a family per shell generation and retries a failed read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replies =
          yield* Queue.unbounded<
            Effect.Effect<OrchestrationV2ThreadFamily, OrchestrationV2GetShellSnapshotError>
          >();
        const client = {
          [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: () => Effect.flatten(Queue.take(replies)),
        } as unknown as WsRpcProtocolClient;
        const session = {
          client,
          initialConfig: Effect.succeed({ shellThreadFamilies: true } as never),
          ready: Effect.void,
          probe: Effect.void,
          inboundFrames: Effect.succeed(0),
          closed: Effect.never,
        } as unknown as RpcSession.RpcSession;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            network: "online",
            phase: "connected",
            attempt: 1,
            generation: 1,
          }),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
          _environmentId,
          effect,
        ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
          _environmentId,
          stream,
        ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const runtime = Atom.runtime(
          Layer.succeed(
            EnvironmentRegistry.EnvironmentRegistry,
            EnvironmentRegistry.EnvironmentRegistry.of({
              run,
              followStream,
            } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
          ),
        );
        const parent = row("parent");
        const child = row("idle-child");
        const shellSnapshot = {
          schemaVersion: 1,
          snapshotSequence: 3,
          projects: [],
          threads: [parent],
          archivedThreads: [],
        } as OrchestrationV2ShellSnapshot;
        const shellAt = (generation: number): EnvironmentShellState => ({
          ...EMPTY_SHELL_STATE,
          status: "live",
          authoritativeSession: session,
          snapshot: Option.some(shellSnapshot),
          generation,
        });
        const shellState = Atom.make<AsyncResult.AsyncResult<EnvironmentShellState>>(
          AsyncResult.success(shellAt(0)),
        );
        const families = createThreadFamilyAtoms(runtime, () => shellState);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );
        const family = families.familyAtom(TARGET.environmentId, parent.id);
        const mergedIds = () =>
          registry.get(families.snapshotAtom(TARGET.environmentId))?.threads.map(({ id }) => id);
        // Waits for the read to finish either way; the assertions read its outcome.
        const settle = AtomRegistry.getResult(registry, family, { suspendOnWaiting: true }).pipe(
          Effect.ignore,
        );
        registry.mount(families.snapshotAtom(TARGET.environmentId));
        families.mount(registry, TARGET.environmentId, parent.id);

        // A cached shell from before this session's first snapshot reads nothing.
        expect(threadFamilyRead(registry.get(family))).toBe("pending");
        expect(yield* Queue.size(replies)).toBe(0);

        registry.set(shellState, AsyncResult.success(shellAt(1)));
        yield* Queue.offer(replies, Effect.succeed({ snapshotSequence: 3, threads: [child] }));
        yield* settle;
        expect(threadFamilyRead(registry.get(family))).toBe("settled");
        expect(mergedIds()).toEqual(["parent", "idle-child"]);

        // A new authoritative snapshot never reuses the old read, even while the next one waits
        // or fails.
        registry.set(shellState, AsyncResult.success(shellAt(2)));
        expect(threadFamilyRead(registry.get(family))).toBe("pending");
        expect(mergedIds()).toEqual(["parent"]);
        yield* Queue.offer(
          replies,
          Effect.fail(new OrchestrationV2GetShellSnapshotError({ message: "read failed" })),
        );
        yield* settle;
        expect(threadFamilyRead(registry.get(family))).toBe("failed");
        expect(mergedIds()).toEqual(["parent"]);

        families.refresh(registry, TARGET.environmentId, parent.id);
        expect(threadFamilyRead(registry.get(family))).toBe("pending");
        yield* Queue.offer(replies, Effect.succeed({ snapshotSequence: 5, threads: [child] }));
        yield* settle;
        expect(threadFamilyRead(registry.get(family))).toBe("settled");
        expect(mergedIds()).toEqual(["parent", "idle-child"]);
      }),
    ),
  );
});

const makeFamilyHarness = Effect.fn(function* () {
  const started = yield* Queue.unbounded<{
    threadId: ThreadId;
    reply: import("effect/Deferred").Deferred<
      OrchestrationV2ThreadFamily,
      OrchestrationV2GetShellSnapshotError
    >;
    stopped: import("effect/Deferred").Deferred<void>;
  }>();
  const activity = { active: 0, peak: 0, calls: 0 };
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: ({ threadId }: { threadId: ThreadId }) =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<
          OrchestrationV2ThreadFamily,
          OrchestrationV2GetShellSnapshotError
        >();
        const stopped = yield* Deferred.make<void>();
        activity.active++;
        activity.calls++;
        activity.peak = Math.max(activity.peak, activity.active);
        yield* Queue.offer(started, { threadId, reply, stopped });
        return yield* Deferred.await(reply).pipe(
          Effect.ensuring(Effect.sync(() => activity.active--)),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        );
      }),
  } as unknown as WsRpcProtocolClient;
  const session = {
    client,
    initialConfig: Effect.succeed({ shellThreadFamilies: true } as never),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  } as unknown as RpcSession.RpcSession;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const supervisorFor = (id: EnvironmentId) =>
    id === TARGET.environmentId
      ? supervisor
      : { ...supervisor, target: new PrimaryConnectionTarget({ ...TARGET, environmentId: id }) };
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisorFor(id));
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    id,
    stream,
  ) =>
    Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisorFor(id));
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      run,
      followStream,
    } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const shellAt = (
    generation: number,
    threads: readonly OrchestrationV2ThreadShell[] = [],
  ): EnvironmentShellState => ({
    ...EMPTY_SHELL_STATE,
    status: "live",
    authoritativeSession: session,
    generation,
    snapshot: Option.some({
      schemaVersion: 1,
      snapshotSequence: generation,
      projects: [],
      threads,
      archivedThreads: [],
    } as OrchestrationV2ShellSnapshot),
  });
  const shells = Atom.family((_id: EnvironmentId) => Atom.make(AsyncResult.success(shellAt(1))));
  const shell = shells(TARGET.environmentId);
  const families = createThreadFamilyAtoms(runtime, shells);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (r) =>
    Effect.sync(() => r.dispose()),
  );
  return {
    started,
    activity,
    session,
    supervisor,
    runtime,
    shellAt,
    shell,
    shells,
    families,
    registry,
  };
});

it.effect("serializes actual family requests in one environment before they reach the RPC", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeFamilyHarness();
      const a = h.families.familyAtom(TARGET.environmentId, ThreadId.make("family-a"));
      const b = h.families.familyAtom(TARGET.environmentId, ThreadId.make("family-b"));
      h.registry.mount(a);
      const first = yield* Queue.take(h.started);
      h.registry.mount(b);
      // Reading the second atom runs its ready runtime synchronously up to its RPC or execution gate.
      h.registry.get(b);
      expect(h.activity.active).toBe(1);
      yield* Deferred.succeed(first.reply, { snapshotSequence: 1, threads: [row("family-a")] });
      yield* Deferred.await(first.stopped);
      const second = yield* Queue.take(h.started);
      yield* Deferred.succeed(second.reply, { snapshotSequence: 1, threads: [row("family-b")] });
      yield* AtomRegistry.getResult(h.registry, b, { suspendOnWaiting: true });
      expect(h.activity.peak).toBe(1);
    }),
  ),
);

const REMOTE = EnvironmentId.make("environment-remote");
const PROJECT = ProjectId.make("fixture-project");
const NOW = "2026-10-28T12:00:00.000Z";
const fullRow = (id: string, patch: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id: ThreadId.make(id),
    projectId: PROJECT,
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 1,
    visibleItemCount: 1,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    forkedFrom: null,
    ...patch,
  }) as OrchestrationV2ThreadShell;
const launched = (
  id: string,
  launcher = "launcher-a",
  patch: Partial<OrchestrationV2ThreadShell> = {},
) =>
  fullRow(id, {
    launchedBy: {
      kind: "launch",
      via: "ssh_thread_launch",
      environmentId: TARGET.environmentId,
      threadId: ThreadId.make(launcher),
      environmentLabel: null,
      threadTitle: null,
    },
    ...patch,
  });

const controllerFor = (h: Effect.Success<ReturnType<typeof makeFamilyHarness>>) => {
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map(
      [TARGET.environmentId, REMOTE].map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({ ...TARGET, environmentId: id }),
          enabled: true,
          profile: Option.none(),
        },
      ]),
    ),
  });
  const shells = createEnvironmentThreadShellAtoms({
    catalogValueAtom: catalog,
    snapshotAtom: h.families.snapshotAtom,
  });
  const readyGenerationAtom = Atom.family((id: EnvironmentId) =>
    Atom.make((get) =>
      get(h.families.readinessAtom(id)) === null ? 0 : get(h.families.generationAtom(id)),
    ),
  );
  const controller = createRemoteLauncherFamilies({
    catalogAtom: catalog,
    threadsAtom: shells.quietThreadShellsAtom,
    readyGenerationAtom,
    familyAtom: h.families.familyAtom,
    mount: h.families.mount,
  });
  return { catalog, shells, controller };
};
const settleFamily = (
  h: Effect.Success<ReturnType<typeof makeFamilyHarness>>,
  id: string,
  registry = h.registry,
) =>
  AtomRegistry.getResult(registry, h.families.familyAtom(TARGET.environmentId, ThreadId.make(id)), {
    suspendOnWaiting: true,
  });

it.effect(
  "restores an omitted remote launcher once, survives StrictMode, folds and remains searchable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeFamilyHarness();
        const root = fullRow("root");
        const a = fullRow("launcher-a", {
          lineage: {
            rootThreadId: root.id,
            parentThreadId: root.id,
            relationshipToParent: "subagent",
          },
        });
        const b = fullRow("launcher-b", { lineage: a.lineage });
        h.registry.set(
          h.shells(REMOTE),
          AsyncResult.success(
            h.shellAt(1, [launched("remote-a"), launched("remote-b", "launcher-b")]),
          ),
        );
        const { controller, shells } = controllerFor(h);
        h.registry.mount(shells.quietThreadShellsAtom);
        const release = controller.retain(h.registry);
        release();
        const again = controller.retain(h.registry);
        const otherOwner = controller.retain(h.registry);
        const request = yield* Queue.take(h.started);
        expect(request.threadId).toBe(a.id);
        yield* Deferred.succeed(request.reply, { snapshotSequence: 1, threads: [root, a, b] });
        yield* settleFamily(h, "launcher-a");
        const all = h.registry.get(shells.quietThreadShellsAtom);
        expect(h.activity.calls).toBe(1);
        expect(all.map((t) => t.id)).toEqual([root.id, a.id, b.id, "remote-a", "remote-b"]);
        const visible = all.filter((t) => t.lineage.relationshipToParent !== "subagent");
        const fold = foldLaunchedThreads({ all, visible, now: NOW });
        expect(fold.roots.map((t) => t.id)).toEqual([root.id]);
        expect(fold.folded.map((t) => t.id)).toEqual(["remote-a", "remote-b"]);
        const shelf = projectSettledLaunchShelf({
          roots: fold.roots,
          fold,
          all: visible,
          isListed: () => true,
          unloadedCount: () => 0,
          visibleCount: 10,
          routeKey: null,
          expanded: true,
        });
        expect(shelf.searchable.map((t) => t.id)).toEqual([root.id, "remote-a", "remote-b"]);
        expect(
          shelf.searchable
            .filter(
              (t) =>
                scoreThreadSearch("remote", threadSearchSubject(t, null), Date.parse(NOW)) !== null,
            )
            .map((t) => t.id),
        ).toEqual(["remote-a", "remote-b"]);
        otherOwner();
        otherOwner();
        yield* Effect.promise(() => Promise.resolve());
        expect(h.registry.get(shells.threadShellsAtom).some((t) => t.id === a.id)).toBe(true);
        again();
        yield* Effect.promise(() => Promise.resolve());
        expect(h.registry.get(shells.threadShellsAtom).map((t) => t.id)).toEqual([
          "remote-a",
          "remote-b",
        ]);
      }),
    ),
);

it.effect(
  "requeues generations and real readiness recovery while cancelling disconnected reads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeFamilyHarness();
        const { controller } = controllerFor(h);
        h.registry.set(h.shell, AsyncResult.success(h.shellAt(0)));
        h.registry.set(h.shells(REMOTE), AsyncResult.success(h.shellAt(1, [launched("remote")])));
        const release = controller.retain(h.registry);
        expect(h.activity.calls).toBe(0);
        h.registry.set(h.shell, AsyncResult.success(h.shellAt(1)));
        const first = yield* Queue.take(h.started);
        h.registry.set(h.shell, AsyncResult.success(h.shellAt(2)));
        yield* Deferred.await(first.stopped);
        const next = yield* Queue.take(h.started);
        expect(h.activity.peak).toBe(1);
        h.registry.set(h.shell, AsyncResult.success({ ...h.shellAt(2), status: "cached" }));
        yield* Deferred.await(next.stopped);
        expect(h.activity.active).toBe(0);
        h.registry.set(h.shell, AsyncResult.success(h.shellAt(2)));
        const recovered = yield* Queue.take(h.started);
        yield* Deferred.fail(
          recovered.reply,
          new OrchestrationV2GetShellSnapshotError({ message: "retryable" }),
        );
        yield* settleFamily(h, "launcher-a").pipe(Effect.ignore);
        expect(h.activity.calls).toBe(3);
        h.registry.set(h.shell, AsyncResult.success({ ...h.shellAt(2), status: "synchronizing" }));
        h.registry.set(h.shell, AsyncResult.success(h.shellAt(2)));
        const retried = yield* Queue.take(h.started);
        yield* Deferred.succeed(retried.reply, {
          snapshotSequence: 2,
          threads: [fullRow("launcher-a")],
        });
        yield* settleFamily(h, "launcher-a");
        release();
        yield* Effect.promise(() => Promise.resolve());
      }),
    ),
);

it.effect("does not reuse a shell owned by the previous session during reconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeFamilyHarness();
      const family = h.families.familyAtom(TARGET.environmentId, ThreadId.make("root"));
      h.registry.mount(family);
      const old = yield* Queue.take(h.started);
      const replacement = { ...h.session };
      yield* SubscriptionRef.set(h.supervisor.session, Option.some(replacement));
      yield* Deferred.await(old.stopped);
      expect(h.activity.active).toBe(0);
      expect(threadFamilyRead(h.registry.get(family))).toBe("pending");
      h.registry.set(
        h.shell,
        AsyncResult.success({ ...h.shellAt(2), authoritativeSession: replacement }),
      );
      const current = yield* Queue.take(h.started);
      yield* Deferred.succeed(current.reply, { snapshotSequence: 2, threads: [] });
      yield* AtomRegistry.getResult(h.registry, family, { suspendOnWaiting: true });
      expect(h.activity.peak).toBe(1);
    }),
  ),
);

it.effect("explicit refresh behind an in-flight family alias reaches the RPC", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeFamilyHarness();
      h.registry.mount(h.families.familyAtom(TARGET.environmentId, ThreadId.make("a")));
      const first = yield* Queue.take(h.started);
      h.registry.mount(h.families.familyAtom(TARGET.environmentId, ThreadId.make("b")));
      h.families.refresh(h.registry, TARGET.environmentId, ThreadId.make("b"));
      yield* Deferred.succeed(first.reply, { snapshotSequence: 1, threads: [row("a"), row("b")] });
      const refreshed = yield* Queue.take(h.started);
      expect(refreshed.threadId).toBe("b");
      yield* Deferred.succeed(refreshed.reply, {
        snapshotSequence: 1,
        threads: [row("b", "fresh")],
      });
      const result = yield* settleFamily(h, "b");
      expect(result.threads[0]?.title).toBe("fresh");
      expect(h.activity.peak).toBe(1);
    }),
  ),
);

it.effect("isolates owners and execution gates between registries sharing one factory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeFamilyHarness();
      const second = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (r) =>
        Effect.sync(() => r.dispose()),
      );
      const { controller, shells } = controllerFor(h);
      for (const registry of [h.registry, second]) {
        registry.mount(h.shells(REMOTE));
        registry.set(h.shells(REMOTE), AsyncResult.success(h.shellAt(1, [launched("remote")])));
      }
      const releaseFirst = controller.retain(h.registry);
      const one = yield* Queue.take(h.started);
      const releaseSecond = controller.retain(second);
      const two = yield* Queue.take(h.started);
      expect(h.activity.active).toBe(2);
      releaseFirst();
      yield* Effect.promise(() => Promise.resolve());
      yield* Deferred.await(one.stopped);
      expect(h.activity.active).toBe(1);
      yield* Deferred.succeed(two.reply, { snapshotSequence: 1, threads: [fullRow("launcher-a")] });
      yield* settleFamily(h, "launcher-a", second);
      expect(second.get(shells.threadShellsAtom).some((t) => t.id === "launcher-a")).toBe(true);
      expect(h.registry.get(shells.threadShellsAtom).some((t) => t.id === "launcher-a")).toBe(
        false,
      );
      releaseSecond();
      yield* Effect.promise(() => Promise.resolve());
    }),
  ),
);

it.effect("matches launch fold candidates and leaves quiet streaming ticks unchanged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeFamilyHarness();
      const { controller, shells, catalog } = controllerFor(h);
      const candidates = [
        launched("eligible"),
        launched("delegate", "ignored-delegate", {
          launchedBy: { ...launched("x").launchedBy!, via: "delegate_task" },
        }),
        launched("promoted", "ignored-promotion", {
          launchedBy: { ...launched("x").launchedBy!, kind: "promotion" },
        }),
        launched("pinned", "ignored-pin", { pinnedAt: DateTime.makeUnsafe(NOW) }),
        launched("archived", "ignored-archive", { archivedAt: DateTime.makeUnsafe(NOW) }),
        launched("deleted", "ignored-delete", { deletedAt: DateTime.makeUnsafe(NOW) }),
        launched("subagent", "ignored-subagent", {
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        }),
      ];
      h.registry.set(h.shells(REMOTE), AsyncResult.success(h.shellAt(1, candidates)));
      const release = controller.retain(h.registry);
      const first = yield* Queue.take(h.started);
      expect(first.threadId).toBe("launcher-a");
      yield* Deferred.succeed(first.reply, { snapshotSequence: 1, threads: [] });
      yield* settleFamily(h, "launcher-a");
      const projection = h.registry.get(controller.projectionAtom);
      expect(projection.candidates.map((r) => r.threadId)).toEqual(["launcher-a"]);
      for (const source of candidates)
        expect(foldsUnderLauncher(source)).toBe(
          source.id === "eligible" || source.id === "archived" || source.id === "deleted",
        );
      const all = h.registry.get(shells.threadShellsAtom);
      const running = fullRow("streaming", {
        latestRunId: "run-fixture" as OrchestrationV2ThreadShell["latestRunId"],
        status: "running",
        activityRunStatus: "running",
      });
      h.registry.set(h.shells(REMOTE), AsyncResult.success(h.shellAt(1, [...candidates, running])));
      const before = h.registry.get(controller.projectionAtom);
      h.registry.set(
        h.shells(REMOTE),
        AsyncResult.success(
          h.shellAt(1, [
            ...candidates,
            {
              ...running,
              updatedAt: DateTime.makeUnsafe("2026-10-28T12:01:00.000Z"),
              itemCount: 3,
              visibleItemCount: 3,
            },
          ]),
        ),
      );
      expect(h.registry.get(controller.projectionAtom)).toBe(before);
      expect(h.activity.calls).toBe(1);
      expect(all.some((t) => t.id === "eligible")).toBe(true);
      h.registry.set(catalog, { isReady: true, entries: new Map() });
      expect(h.registry.get(controller.projectionAtom).candidates).toEqual([]);
      release();
      yield* Effect.promise(() => Promise.resolve());
    }),
  ),
);

it.effect(
  "keeps an archived launcher's active family without inventing an absent edge or rereading",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeFamilyHarness();
        h.registry.set(h.shells(REMOTE), AsyncResult.success(h.shellAt(1, [launched("remote")])));
        const { controller, shells } = controllerFor(h);
        const release = controller.retain(h.registry);
        const read = yield* Queue.take(h.started);
        yield* Deferred.succeed(read.reply, {
          snapshotSequence: 1,
          threads: [fullRow("active-root")],
        });
        yield* settleFamily(h, "launcher-a");
        const all = h.registry.get(shells.threadShellsAtom);
        const fold = foldLaunchedThreads({ visible: all, all, now: NOW });
        expect(fold.roots.map((t) => t.id)).toEqual(["active-root", "remote"]);
        expect(h.activity.calls).toBe(1);
        release();
        yield* Effect.promise(() => Promise.resolve());
      }),
    ),
);

it.effect(
  "projects merged families through the production Settled frontier, count, slice, growth and search",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeFamilyHarness();
        const date = (day: number) =>
          DateTime.makeUnsafe(`2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`);
        const settled = (id: string, day: number) =>
          fullRow(id, { settledOverride: "settled", settledAt: date(day) });
        const root = settled("old-launcher", 1);
        const oldGroup = settled("old-group", 2);
        const recent = launched("recent-child", "old-launcher", {
          settledOverride: "settled",
          settledAt: date(27),
        });
        const oldChild = launched("old-child", "old-group", {
          settledOverride: "settled",
          settledAt: date(3),
        });
        h.registry.set(h.shells(REMOTE), AsyncResult.success(h.shellAt(1, [recent, oldChild])));
        const { shells } = controllerFor(h);
        h.registry.mount(shells.threadShellsAtom);
        h.families.mountRows(
          h.registry,
          TARGET.environmentId,
          "fixture-family",
          Atom.make([{ snapshotSequence: 1, threads: [root, oldGroup] }]),
        );
        const all = h.registry.get(shells.threadShellsAtom);
        const fold = foldLaunchedThreads({ all, visible: all, now: NOW });
        const older = {
          before: "2026-10-20T00:00:00.000Z",
          beforeMs: Date.parse("2026-10-20T00:00:00.000Z"),
          asOfSequence: 1,
          counts: new Map([[PROJECT, 3]]),
        };
        const pages = {
          status: "ready" as const,
          reads: [],
          frontier: { settledAt: older.before },
        };
        const frontier = settledShelfFrontier([{ older, pages }]);
        const scopes = [{ environmentId: TARGET.environmentId, projectIds: null }];
        const project = (visibleCount: number, routeKey: string | null = null) =>
          projectSettledLaunchShelf({
            roots: fold.roots,
            fold,
            all,
            isListed: (t) => isListedSettledThread(t.source, frontier),
            unloadedCount: (threads) =>
              unloadedOlderSettledCount({
                olderSettled: (id) => (id === TARGET.environmentId ? older : null),
                scopes,
                threads,
              }),
            visibleCount,
            routeKey,
            expanded: true,
          });
        const shown = project(10);
        expect(shown.listed.map((t) => t.id)).toEqual([root.id]);
        expect(shown.rendered.map((t) => t.id)).toEqual([root.id]);
        expect(shown.count).toBe(3);
        expect(project(0).rendered).toEqual([]);
        // Scoped keys are shared with the sidebar rather than reconstructed by this fixture.
        const scoped = (awaitKey: typeof oldGroup.id) =>
          scopedThreadKey(scopeThreadRef(TARGET.environmentId, awaitKey));
        expect(project(0, scoped(oldGroup.id)).rendered.map((t) => t.id)).toEqual([oldGroup.id]);
        expect(shown.searchable.map((t) => t.id)).toEqual([
          root.id,
          oldGroup.id,
          recent.id,
          oldChild.id,
        ]);
        expect(
          shown.searchable
            .filter(
              (t) =>
                scoreThreadSearch("recent-child", threadSearchSubject(t, null), Date.parse(NOW)) !==
                null,
            )
            .map((t) => t.id),
        ).toEqual([recent.id]);
        const requested = new Map<EnvironmentId, number>();
        const environments = new Map([[TARGET.environmentId, { older, pages }]]);
        expect(
          wantedOlderSettledPages({
            requested,
            environments,
            listedCount: shown.listed.length,
            visibleCount: 1,
          }),
        ).toBe(requested);
        expect(
          wantedOlderSettledPages({
            requested,
            environments,
            listedCount: shown.listed.length,
            visibleCount: 2,
          }).get(TARGET.environmentId),
        ).toBe(1);
      }),
    ),
);

it.effect(
  "serializes already mounted aliases after generation changes while other environments progress",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeFamilyHarness();
        const a = h.families.familyAtom(TARGET.environmentId, ThreadId.make("a"));
        const b = h.families.familyAtom(TARGET.environmentId, ThreadId.make("b"));
        h.registry.mount(a);
        h.registry.mount(b);
        const first = yield* Queue.take(h.started);
        const both = [row("a"), row("b")];
        yield* Deferred.succeed(first.reply, { snapshotSequence: 1, threads: both });
        yield* AtomRegistry.getResult(h.registry, b, { suspendOnWaiting: true });
        expect(h.activity.calls).toBe(1);
        h.registry.set(h.shell, AsyncResult.success(h.shellAt(2)));
        const next = yield* Queue.take(h.started);
        const remote = h.families.familyAtom(REMOTE, ThreadId.make("other-env"));
        h.registry.mount(remote);
        const parallel = yield* Queue.take(h.started);
        expect(parallel.threadId).toBe("other-env");
        expect(h.activity.active).toBe(2);
        yield* Deferred.succeed(parallel.reply, { snapshotSequence: 1, threads: [] });
        yield* AtomRegistry.getResult(h.registry, remote, { suspendOnWaiting: true });
        yield* Deferred.succeed(next.reply, { snapshotSequence: 2, threads: both });
        yield* AtomRegistry.getResult(h.registry, a, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(h.registry, b, { suspendOnWaiting: true });
        expect(h.activity.calls).toBe(3);
      }),
    ),
);
