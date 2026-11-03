import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { loadShellSnapshotParts } from "./ShellStream.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export const makeSingleFlight = Effect.fn("ShellSnapshotLoads.makeSingleFlight")(function* <
  A,
  E,
>() {
  const scope = yield* Effect.scope;
  const inFlight = new Map<boolean, Deferred.Deferred<A, E>>();
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      const pending = [...inFlight.values()];
      inFlight.clear();
      return pending;
    }).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(pending, (done) => Deferred.interrupt(done), { discard: true }),
      ),
    ),
  );
  const run = (key: boolean, load: Effect.Effect<A, E>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.sync(() => {
        if (closed) return { kind: "closed" } as const;
        const existing = inFlight.get(key);
        if (existing !== undefined) return { kind: "joined", done: existing } as const;
        const done = Deferred.makeUnsafe<A, E>();
        inFlight.set(key, done);
        return { kind: "owner", done } as const;
      }).pipe(
        Effect.flatMap((slot) => {
          if (slot.kind === "closed") return Effect.interrupt;
          const fork =
            slot.kind === "owner"
              ? load.pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      if (inFlight.get(key) === slot.done) inFlight.delete(key);
                    }).pipe(Effect.andThen(Deferred.done(slot.done, exit))),
                  ),
                  Effect.forkIn(scope),
                  Effect.asVoid,
                )
              : Effect.void;
          return fork.pipe(Effect.andThen(restore(Deferred.await(slot.done))));
        }),
      ),
    );
  return { run };
});
const makeLoad = (
  sql: SqlClient.SqlClient,
  threadManagement: ThreadManagementService.ThreadManagementService["Service"],
  projects: ProjectStore.ProjectStoreV2["Service"],
  applicationEvents: OrchestrationEventStore.OrchestrationEventStore["Service"],
  omitIdleSubagents: boolean,
) =>
  loadShellSnapshotParts({
    sql,
    readThreads: threadManagement.readShellSnapshot({
      location: "active",
      ...(omitIdleSubagents ? { omitIdleSubagents: true } : {}),
    }),
    listProjects: projects.listShells(),
    latestSequence: applicationEvents.latestApplicationSequence,
  });

type Load = ReturnType<typeof makeLoad>;

export class ShellSnapshotLoads extends Context.Service<
  ShellSnapshotLoads,
  { readonly active: (omitIdleSubagents: boolean) => Load }
>()("goat/orchestration-v2/ShellSnapshotLoads") {}

export const layer = Layer.effect(
  ShellSnapshotLoads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const singleFlight = yield* makeSingleFlight<Effect.Success<Load>, Effect.Error<Load>>();
    return ShellSnapshotLoads.of({
      active: Effect.fn("ShellSnapshotLoads.active")((omitIdleSubagents: boolean) =>
        singleFlight.run(
          omitIdleSubagents,
          makeLoad(sql, threadManagement, projects, applicationEvents, omitIdleSubagents),
        ),
      ),
    });
  }),
);

export const withRuntime = <A, E, R>(runtime: Layer.Layer<A, E, R>) =>
  layer.pipe(
    Layer.provide(runtime),
    Layer.provide(ProjectStore.layer),
    Layer.provide(OrchestrationEventStore.layer),
  );
