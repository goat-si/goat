import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { arrayElementsEqual } from "./entities.ts";
import { environmentConnectionAtoms } from "./environmentConnections.ts";
import { createEnvironmentQueryAtomFamily, selectEnvironmentQueryData } from "./runtime.ts";
import type { EnvironmentShellState } from "./shell.ts";

const EMPTY_FAMILY: OrchestrationV2ThreadFamily = { snapshotSequence: 0, threads: [] };
const EMPTY_READS: ReadonlyArray<OrchestrationV2ThreadFamily> = [];

interface MountedRows {
  readonly rows: Atom.Atom<ReadonlyArray<OrchestrationV2ThreadFamily>>;
  readonly count: number;
}
const EMPTY_MOUNTS: ReadonlyMap<string, MountedRows> = new Map();
const AWAITING_AUTHORITATIVE_SHELL = AsyncResult.initial<never, never>(true);

interface FamilyReadiness {
  readonly generation: number;
  readonly session: RpcSession;
}

interface FamilyLane {
  readonly semaphore: Semaphore.Semaphore;
  generation: number;
  session: RpcSession | null;
  nextRefreshVersion: number;
  readonly families: Map<ThreadId, OrchestrationV2ThreadFamily>;
  readonly requestedRefresh: Map<
    ThreadId,
    { readonly ready: FamilyReadiness; readonly version: number }
  >;
  readonly consumedRefresh: Map<ThreadId, number>;
}

interface MergedFamilySnapshot {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly removedAt: ReadonlyMap<ThreadId, number>;
  readonly families: ReadonlyArray<OrchestrationV2ThreadFamily>;
  readonly merged: OrchestrationV2ShellSnapshot;
}

/** Whether a family read can decide anything yet. Only a settled read can prove a thread is gone. */
export type ThreadFamilyRead = "pending" | "failed" | "settled";

export function threadFamilyRead(
  result: AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, unknown>,
): ThreadFamilyRead {
  // A failure whose retry is in flight is pending, so callers do not restart that retry.
  if (result.waiting) return "pending";
  if (AsyncResult.isFailure(result)) return "failed";
  return AsyncResult.isSuccess(result) ? "settled" : "pending";
}

/**
 * Family rows the shell does not have. A shell row is at least as new as any family copy, since
 * shell deltas carry every change; a family copy read before the shell removed that thread is
 * stale.
 */
export function threadFamilyRowsMissingFromShell(input: {
  readonly shellThreads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly families: ReadonlyArray<OrchestrationV2ThreadFamily>;
  readonly removedAt: ReadonlyMap<ThreadId, number>;
}): ReadonlyArray<OrchestrationV2ThreadShell> {
  const present = new Set<ThreadId>(input.shellThreads.map((thread) => thread.id));
  const missing: OrchestrationV2ThreadShell[] = [];
  for (const family of input.families) {
    for (const thread of family.threads) {
      if (present.has(thread.id)) continue;
      if ((input.removedAt.get(thread.id) ?? -1) > family.snapshotSequence) continue;
      present.add(thread.id);
      missing.push(thread);
    }
  }
  return missing;
}

/**
 * Shells with `omitIdleSubagents` or `omitOlderSettled` leave rows to on-demand reads: a family is
 * every active thread sharing a `lineage.rootThreadId`, read once per shell generation; shelf pages
 * and search rows mount through `mountRows`. All merge behind shell rows, which win (deltas carry
 * every change), and are never persisted.
 */
export function createThreadFamilyAtoms<R, ER, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, E>>,
) {
  const shellStateValue = (state: AsyncResult.AsyncResult<EnvironmentShellState, E>) =>
    Option.getOrNull(AsyncResult.value(state));
  const generationAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => shellStateValue(get(shellStateAtom(environmentId)))?.generation ?? 0).pipe(
      Atom.withLabel(`environment-shell-generation:${environmentId}`),
    ),
  );
  const connectionAtom = environmentConnectionAtoms(runtime);
  const readinessAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): FamilyReadiness | null => {
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      const connection = Option.getOrNull(AsyncResult.value(get(connectionAtom(environmentId))));
      const session = connection === null ? null : Option.getOrNull(connection[1]);
      if (
        state === null ||
        state.status !== "live" ||
        state.generation <= 0 ||
        Option.isNone(state.snapshot) ||
        connection?.[0].phase !== "connected" ||
        session === null ||
        state.authoritativeSession !== session
      )
        return null;
      const previous = Option.getOrNull(get.self<FamilyReadiness | null>());
      return previous?.generation === state.generation && previous.session === session
        ? previous
        : { generation: state.generation, session };
    }).pipe(Atom.withLabel(`environment-thread-family-readiness:${environmentId}`)),
  );
  const lanes = new WeakMap<AtomRegistry.AtomRegistry, Map<EnvironmentId, FamilyLane>>();
  const laneFor = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    let environments = lanes.get(registry);
    if (environments === undefined) {
      environments = new Map();
      lanes.set(registry, environments);
    }
    let lane = environments.get(environmentId);
    if (lane === undefined) {
      lane = {
        semaphore: Semaphore.makeUnsafe(1),
        generation: 0,
        session: null,
        nextRefreshVersion: 0,
        families: new Map(),
        requestedRefresh: new Map(),
        consumedRefresh: new Map(),
      };
      environments.set(environmentId, lane);
    }
    return lane;
  };
  const readinessKeys = new WeakMap<FamilyReadiness, number>();
  let nextReadinessKey = 0;
  const readinessKey = (ready: FamilyReadiness) => {
    let key = readinessKeys.get(ready);
    if (key === undefined) {
      key = ++nextReadinessKey;
      readinessKeys.set(ready, key);
    }
    return key;
  };

  const familyQueryAtom = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:thread-family",
    staleTimeMs: Number.POSITIVE_INFINITY,
    idleTtlMs: 0,
    execute: Effect.fn("ThreadFamilies.read")(function* (input: {
      readonly threadId: ThreadId;
      readonly generation: number;
      readonly readinessKey: number;
    }) {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const registry = yield* AtomRegistry.AtomRegistry;
      const environmentId = supervisor.target.environmentId;
      const readiness = readinessAtom(environmentId);
      const lane = laneFor(registry, environmentId);
      const matches = (value: FamilyReadiness | null) =>
        value !== null &&
        value.generation === input.generation &&
        readinessKey(value) === input.readinessKey;
      const captured = registry.get(readiness);
      if (captured === null || !matches(captured)) return yield* Effect.interrupt;
      const refresh = lane.requestedRefresh.get(input.threadId);
      const refreshVersion =
        refresh?.ready.generation === captured.generation &&
        refresh.ready.session === captured.session
          ? refresh.version
          : 0;
      const invalidated = yield* Deferred.make<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registry.subscribe(
            readiness,
            (value) => {
              if (!matches(value)) Deferred.doneUnsafe(invalidated, Effect.void);
            },
            { immediate: true },
          ),
        ),
        (stop) => Effect.sync(stop),
      );
      const ensureCurrent = Effect.gen(function* () {
        const state = yield* SubscriptionRef.get(supervisor.state);
        const session = yield* SubscriptionRef.get(supervisor.session);
        if (
          Deferred.isDoneUnsafe(invalidated) ||
          !matches(registry.get(readiness)) ||
          state.phase !== "connected" ||
          Option.isNone(session) ||
          session.value !== captured.session
        )
          return yield* Effect.interrupt;
      });
      // Session replacement can precede the connection atom's corresponding update.
      const supervisorChanged = SubscriptionRef.changes(supervisor.state).pipe(
        Stream.zipLatest(SubscriptionRef.changes(supervisor.session)),
        Stream.filter(
          ([state, session]) =>
            state.phase !== "connected" ||
            Option.isNone(session) ||
            session.value !== captured.session,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const cancelled = Effect.raceFirst(Deferred.await(invalidated), supervisorChanged).pipe(
        Effect.andThen(Effect.interrupt),
      );
      return yield* Effect.raceFirst(
        lane.semaphore.withPermit(
          Effect.scoped(
            Effect.gen(function* () {
              yield* ensureCurrent;
              if (lane.generation !== input.generation || lane.session !== captured.session) {
                lane.generation = input.generation;
                lane.session = captured.session;
                lane.families.clear();
                lane.consumedRefresh.clear();
                for (const [threadId, refresh] of lane.requestedRefresh) {
                  if (
                    refresh.ready.generation !== input.generation ||
                    refresh.ready.session !== captured.session
                  )
                    lane.requestedRefresh.delete(threadId);
                }
              }
              const cached = lane.families.get(input.threadId);
              if (
                cached !== undefined &&
                (lane.consumedRefresh.get(input.threadId) ?? 0) >= refreshVersion
              )
                return cached;
              // Configuration failures must not turn a missing family into an empty success.
              const config = yield* captured.session.initialConfig;
              yield* ensureCurrent;
              const family =
                config.shellThreadFamilies === true
                  ? yield* request(ORCHESTRATION_V2_WS_METHODS.getThreadFamily, {
                      threadId: input.threadId,
                    })
                  : EMPTY_FAMILY;
              yield* ensureCurrent;
              lane.families.set(input.threadId, family);
              for (const thread of family.threads) lane.families.set(thread.id, family);
              lane.consumedRefresh.set(input.threadId, refreshVersion);
              return family;
            }),
          ),
        ),
        cancelled,
      );
    }, Effect.scoped),
  });
  const queryFor = (environmentId: EnvironmentId, threadId: ThreadId, ready: FamilyReadiness) =>
    familyQueryAtom({
      environmentId,
      input: {
        threadId,
        generation: ready.generation,
        readinessKey: readinessKey(ready),
      },
    });

  const familyAtom = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    return Atom.make((get) => {
      const ready = get(readinessAtom(environmentId));
      return ready === null
        ? AWAITING_AUTHORITATIVE_SHELL
        : get(queryFor(environmentId, threadId, ready));
    }).pipe(Atom.withLabel(`environment-thread-family:${key}`));
  });
  const familyKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
    JSON.stringify([environmentId, threadId]);

  /** Reads the current generation's family again, so a failed read does not last the session. */
  const refresh = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => {
    const ready = registry.get(readinessAtom(environmentId));
    if (ready === null) return;
    const lane = laneFor(registry, environmentId);
    lane.requestedRefresh.set(threadId, {
      ready,
      version: ++lane.nextRefreshVersion,
    });
    registry.refresh(queryFor(environmentId, threadId, ready));
  };

  const mountsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(EMPTY_MOUNTS).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-thread-family-mounts:${environmentId}`),
    ),
  );

  const familyRowsAtom = Atom.family((key: string) =>
    Atom.make((get): ReadonlyArray<OrchestrationV2ThreadFamily> => {
      const family = selectEnvironmentQueryData(get(familyAtom(key)));
      return family === null ? EMPTY_READS : [family];
    }).pipe(Atom.withLabel(`environment-thread-family-rows:${key}`)),
  );

  /**
   * Merges `rows` behind the shell rows until the returned release runs. Reads read under `key`
   * share one entry; each read's `snapshotSequence` decides which removals drop its rows.
   */
  const mountRows = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    key: string,
    rows: Atom.Atom<ReadonlyArray<OrchestrationV2ThreadFamily>>,
  ): (() => void) => {
    const atom = mountsAtom(environmentId);
    const mounts = registry.get(atom);
    const entry = mounts.get(key);
    registry.set(
      atom,
      new Map(mounts).set(key, { rows: entry?.rows ?? rows, count: (entry?.count ?? 0) + 1 }),
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = new Map(registry.get(atom));
      const entry = next.get(key);
      if (entry !== undefined && entry.count > 1)
        next.set(key, { ...entry, count: entry.count - 1 });
      else next.delete(key);
      registry.set(atom, next);
    };
  };

  /** Keeps a thread's family in the merged rows until the returned release runs. */
  const mount = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ): (() => void) => {
    const key = familyKey(environmentId, threadId);
    const release = mountRows(registry, environmentId, `family:${key}`, familyRowsAtom(key));
    // Mounting again after a failure retries instead of keeping the failure until reconnect.
    if (threadFamilyRead(registry.get(familyAtom(key))) === "failed") {
      refresh(registry, environmentId, threadId);
    }
    return release;
  };

  const mergedSnapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): MergedFamilySnapshot | null => {
      const previous = Option.getOrNull(get.self<MergedFamilySnapshot | null>());
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      const snapshot = state === null ? null : Option.getOrNull(state.snapshot);
      const mounts = get(mountsAtom(environmentId));
      if (snapshot === null || state === null) return null;
      // A read from before the latest authoritative snapshot can hold threads removed before it,
      // and that snapshot cleared those removals; such reads (a cached search) wait for new ones.
      const cut = snapshot.olderSettled?.asOfSequence ?? 0;
      const families = [...mounts.values()].flatMap(({ rows }) =>
        get(rows).filter((read) => read.snapshotSequence >= cut),
      );
      // Most shell updates move only the cursor. With the same rows, removals and families, keep
      // the merged rows so thread lists skip their rebuild.
      const unchanged =
        previous !== null &&
        previous.snapshot.threads === snapshot.threads &&
        previous.removedAt === state.removedAt &&
        arrayElementsEqual(previous.families, families);
      if (unchanged && previous !== null && previous.snapshot === snapshot) return previous;
      let merged: OrchestrationV2ShellSnapshot;
      if (unchanged && previous !== null) {
        merged =
          previous.merged === previous.snapshot
            ? snapshot
            : { ...snapshot, threads: previous.merged.threads };
      } else {
        const extras = threadFamilyRowsMissingFromShell({
          shellThreads: snapshot.threads,
          removedAt: state.removedAt,
          families,
        });
        merged =
          extras.length === 0
            ? snapshot
            : { ...snapshot, threads: [...snapshot.threads, ...extras] };
      }
      return { snapshot, removedAt: state.removedAt, families, merged };
    }).pipe(Atom.withLabel(`environment-snapshot-with-families:${environmentId}`)),
  );
  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(mergedSnapshotAtom(environmentId))?.merged ?? null),
  );

  return {
    /** Atom<number>: authoritative snapshot generation, including 0 before the first snapshot. */
    generationAtom,
    /** Atom<{ generation: number; session: RpcSession } | null>: current live snapshot owner. */
    readinessAtom,
    /** The shell snapshot plus the rows of every mounted family. */
    snapshotAtom,
    /** The current generation's family read, for decisions that need a settled answer. */
    familyAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      familyAtom(familyKey(environmentId, threadId)),
    mount,
    mountRows,
    refresh,
  };
}
