import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as CloudFolderTrust from "./CloudFolderTrust.ts";

const projectCreated = (sequence: number, workspaceRoot: string) => ({
  sequence,
  aggregateKind: "project",
  type: "project.created",
  payload: { workspaceRoot },
});
const threadUpdated = (sequence: number, worktreePath: string | null) => ({
  sequence,
  commandId: null,
  event: { type: "thread.metadata-updated", payload: { worktreePath } },
});

it.effect("trusts project roots at start, then each new project and worktree once", () =>
  Effect.gen(function* () {
    const trusted = yield* Queue.unbounded<string>();
    const events = yield* Queue.unbounded<unknown>();
    let streamedAfter: number | undefined;
    const ensure = (cwd: string) => Queue.offer(trusted, cwd).pipe(Effect.asVoid);
    const service = yield* CloudFolderTrust.make.pipe(
      Effect.provideService(
        ProviderInstanceRegistry.ProviderInstanceRegistry,
        ProviderInstanceRegistry.ProviderInstanceRegistry.of({
          listInstances: Effect.succeed([
            { enabled: true, folderTrust: { ensure } },
            { enabled: false, folderTrust: { ensure: () => Effect.die("disabled instance") } },
            { enabled: true },
          ]),
        } as never),
      ),
      Effect.provideService(
        ProjectStore.ProjectStoreV2,
        ProjectStore.ProjectStoreV2.of({
          list: () =>
            Effect.succeed([
              { workspaceRoot: "/projects/goat", deletedAt: null },
              { workspaceRoot: "/projects/gone", deletedAt: "2026-10-01T00:00:00.000Z" },
            ]),
        } as never),
      ),
      Effect.provideService(
        OrchestrationEventStore.OrchestrationEventStore,
        OrchestrationEventStore.OrchestrationEventStore.of({
          latestApplicationSequence: Effect.succeed(7),
          streamApplicationEvents: (input: { readonly afterSequence?: number }) => {
            streamedAfter = input.afterSequence;
            return Stream.fromQueue(events);
          },
        } as never),
      ),
    );
    yield* service.start();
    assert.equal(yield* Queue.take(trusted), "/projects/goat");
    assert.equal(streamedAfter, 7);

    yield* Queue.offerAll(events, [
      projectCreated(8, "/projects/new"),
      threadUpdated(9, "/worktrees/goat/feature"),
      threadUpdated(10, null),
      // Every metadata update repeats the worktree; it was already handed over.
      threadUpdated(11, "/worktrees/goat/feature"),
      projectCreated(12, "/projects/last"),
    ]);
    assert.deepEqual(
      [yield* Queue.take(trusted), yield* Queue.take(trusted), yield* Queue.take(trusted)],
      ["/projects/new", "/worktrees/goat/feature", "/projects/last"],
    );
  }).pipe(Effect.scoped),
);
