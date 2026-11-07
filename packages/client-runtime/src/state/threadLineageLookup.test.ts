import { it, expect } from "@effect/vitest";
import {
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ThreadFamily,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type * as RpcSession from "../rpc/session.ts";
import { createThreadLineageLookup } from "./threadLineageLookup.ts";
import type { EnvironmentShellState } from "./shell.ts";
import {
  makeEnvironmentQueryHarness,
  mountEnvironmentQuery,
  QUERY_ENVIRONMENT,
  readEnvironmentQuery,
} from "./runtimeTestSupport.ts";

it.effect("refreshes the title lookup on removal and retains no stale deletion result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Queue.bounded<Deferred.Deferred<OrchestrationV2ThreadFamily>>(4);
      const harness = yield* makeEnvironmentQueryHarness(Effect.void, {
        rpcSession: {
          client: {
            [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: () =>
              Effect.gen(function* () {
                const answer = yield* Deferred.make<OrchestrationV2ThreadFamily>();
                yield* Queue.offer(requests, answer);
                return yield* Deferred.await(answer);
              }),
          },
        } as unknown as RpcSession.RpcSession,
      });
      const shell = Atom.make<Pick<EnvironmentShellState, "removedAt">>({
        removedAt: new Map(),
      }).pipe(Atom.keepAlive);
      const fork = ThreadId.make("fork");
      const query = createThreadLineageLookup(harness.runtime, () => shell).query({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        input: { threadId: ThreadId.make("root"), lookupThreadIds: [fork], lookupOnly: true },
      });
      const registry = yield* mountEnvironmentQuery(query);
      const settled: Array<OrchestrationV2ThreadFamily> = [];
      const unsubscribe = registry.subscribe(query, (result) => {
        if (AsyncResult.isSuccess(result) && !result.waiting) settled.push(result.value);
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* Deferred.succeed(yield* Queue.take(requests), {
        snapshotSequence: 1,
        threads: [],
        lookupTitles: { [fork]: "Fork" },
      });
      expect((yield* readEnvironmentQuery(registry, query)).lookupTitles).toEqual({ fork: "Fork" });
      registry.set(shell, { removedAt: new Map([[fork, 2]]) });
      const stale = yield* Queue.take(requests);
      registry.set(shell, { removedAt: new Map([[fork, 3]]) });
      const current = yield* Queue.take(requests);
      yield* Deferred.succeed(stale, {
        snapshotSequence: 2,
        threads: [],
        lookupTitles: { [fork]: "Fork" },
      });
      yield* Deferred.succeed(current, { snapshotSequence: 3, threads: [], lookupTitles: {} });
      expect((yield* readEnvironmentQuery(registry, query)).lookupTitles).toEqual({});
      expect(settled.map((result) => result.lookupTitles)).toEqual([{ fork: "Fork" }, {}]);
    }),
  ),
);

it.effect("checks more than one bounded page sequentially", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Queue.bounded<{
        ids: ReadonlyArray<ThreadId>;
        answer: Deferred.Deferred<OrchestrationV2ThreadFamily>;
      }>(2);
      const harness = yield* makeEnvironmentQueryHarness(Effect.void, {
        rpcSession: {
          client: {
            [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: (input: {
              lookupThreadIds: ReadonlyArray<ThreadId>;
            }) =>
              Effect.gen(function* () {
                const answer = yield* Deferred.make<OrchestrationV2ThreadFamily>();
                yield* Queue.offer(requests, { ids: input.lookupThreadIds, answer });
                return yield* Deferred.await(answer);
              }),
          },
        } as unknown as RpcSession.RpcSession,
      });
      const shell = Atom.make<Pick<EnvironmentShellState, "removedAt">>({ removedAt: new Map() });
      const ids = Array.from({ length: 101 }, (_, index) => ThreadId.make(`fork-${index}`));
      const atom = createThreadLineageLookup(harness.runtime, () => shell).resolution(
        QUERY_ENVIRONMENT.environmentId,
        ThreadId.make("root"),
        ids,
      );
      const registry = AtomRegistry.make();
      const completed = yield* Deferred.make<void>();
      const unsubscribe = registry.subscribe(
        atom,
        (result) => {
          if (result.checked.size === ids.length) Deferred.doneUnsafe(completed, Exit.void);
        },
        { immediate: true },
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe();
          registry.dispose();
        }),
      );
      const first = yield* Queue.take(requests);
      expect(first.ids).toHaveLength(100);
      yield* Deferred.succeed(first.answer, { snapshotSequence: 1, threads: [], lookupTitles: {} });
      const second = yield* Queue.take(requests);
      expect(second.ids).toEqual([ids[100]]);
      yield* Deferred.succeed(second.answer, {
        snapshotSequence: 1,
        threads: [],
        lookupTitles: {},
      });
      yield* Deferred.await(completed);
      expect(registry.get(atom).checked.size).toBe(101);
    }),
  ),
);

it.effect("keeps rows unverified when an older server omits lookup results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Queue.bounded<Deferred.Deferred<OrchestrationV2ThreadFamily>>(1);
      const harness = yield* makeEnvironmentQueryHarness(Effect.void, {
        rpcSession: {
          client: {
            [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: () =>
              Effect.gen(function* () {
                const answer = yield* Deferred.make<OrchestrationV2ThreadFamily>();
                yield* Queue.offer(requests, answer);
                return yield* Deferred.await(answer);
              }),
          },
        } as unknown as RpcSession.RpcSession,
      });
      const shell = Atom.make<Pick<EnvironmentShellState, "removedAt">>({ removedAt: new Map() });
      const lineage = createThreadLineageLookup(harness.runtime, () => shell);
      const root = ThreadId.make("root");
      const fork = ThreadId.make("fork");
      const atom = lineage.resolution(QUERY_ENVIRONMENT.environmentId, root, [fork]);
      const query = lineage.query({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        input: { threadId: root, lookupThreadIds: [fork], lookupOnly: true },
      });
      const registry = yield* mountEnvironmentQuery(query);
      const unmount = registry.mount(atom);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      yield* Deferred.succeed(yield* Queue.take(requests), { snapshotSequence: 1, threads: [] });
      yield* readEnvironmentQuery(registry, query);
      expect(registry.get(atom).checked.size).toBe(0);
    }),
  ),
);
