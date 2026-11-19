import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ArchivedShellSnapshot,
} from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { Atom } from "effect/reactivity";
import type { HttpClient } from "effect/http";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createOrchestrationEnvironmentAtoms } from "./orchestration.ts";
import { v2Now, v2Project, v2ThreadId, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  QUERY_ENVIRONMENT,
  makeEnvironmentQueryHarness,
  mountEnvironmentQuery,
  readEnvironmentQuery,
} from "./runtimeTestSupport.ts";
import type { EnvironmentShellState } from "./shell.ts";

it.effect("refreshes the open archive when the destination shell removes a thread", () =>
  Effect.gen(function* () {
    const requests =
      yield* Queue.unbounded<Deferred.Deferred<OrchestrationV2ArchivedShellSnapshot>>();
    const harness = yield* makeEnvironmentQueryHarness(Effect.void, {
      rpcSession: {
        client: {
          [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: () =>
            Effect.gen(function* () {
              const answer = yield* Deferred.make<OrchestrationV2ArchivedShellSnapshot>();
              yield* Queue.offer(requests, answer);
              return yield* Deferred.await(answer);
            }),
        },
      } as unknown as RpcSession.RpcSession,
    });
    const shellState = Atom.make<Pick<EnvironmentShellState, "removedAt">>({
      removedAt: new Map(),
    }).pipe(Atom.keepAlive);
    const runtime = harness.runtime as unknown as Atom.AtomRuntime<
      EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient
    >;
    const atom = createOrchestrationEnvironmentAtoms(runtime, {
      shellState: () => shellState,
    }).archivedShellSnapshot({ environmentId: QUERY_ENVIRONMENT.environmentId, input: {} });
    const page = (threads: OrchestrationV2ArchivedShellSnapshot["threads"]) => ({
      schemaVersion: 1 as const,
      snapshotSequence: 1,
      projects: [v2Project],
      threads,
    });
    const registry = yield* mountEnvironmentQuery(atom);
    const archivedIds = Effect.map(readEnvironmentQuery(registry, atom), (snapshot) =>
      snapshot.threads.map((thread) => thread.id),
    );
    yield* Deferred.succeed(yield* Queue.take(requests), page([]));
    expect(yield* archivedIds).toEqual([]);
    registry.set(shellState, { removedAt: new Map([[v2ThreadId, 2]]) });
    expect(registry.get(atom).waiting).toBe(true);
    yield* Deferred.succeed(
      yield* Queue.take(requests),
      page([{ ...v2ThreadShell, archivedAt: v2Now }]),
    );
    expect(yield* archivedIds).toEqual([v2ThreadId]);
    registry.set(shellState, { removedAt: new Map([[v2ThreadId, 3]]) });
    yield* Deferred.succeed(yield* Queue.take(requests), page([]));
    expect(yield* archivedIds).toEqual([]);
  }),
);
