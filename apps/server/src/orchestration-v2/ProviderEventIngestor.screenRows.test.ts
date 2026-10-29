import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnItemId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ComputerUseCallApps, makeCallApps } from "../cua/ComputerUseCallApps.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingestor-rows-git-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = it.layer(
  Layer.mergeAll(
    layerTestDatabase,
    layerTestStores,
    layerTestEventSink,
    IdAllocator.layer,
    ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerTestStores,
          layerTestEventSink,
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          layerGit,
        ),
      ),
    ),
  ),
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const threadCreatedEvent = (now: DateTime.Utc) =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({ fixtureName: "ingestor-rows" });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "ingestor-rows",
      projectId,
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Screen rows",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const event: OrchestrationV2DomainEvent = {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    };
    return event;
  });

layer("ProviderEventIngestorV2 screen rows", (it) => {
  it.effect(
    "a resolved screen row keeps its title and summary through later updates without its result, across a restart",
    () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadEvent = yield* threadCreatedEvent(now);
        const threadId = threadEvent.threadId;
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const cellRow = (
          id: string,
          status: OrchestrationV2TurnItem["status"],
          output?: unknown,
        ): OrchestrationV2TurnItem => ({
          id: TurnItemId.make(id),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status,
          title: "goat screen run",
          startedAt: now,
          completedAt: status === "completed" ? now : null,
          updatedAt: now,
          type: "dynamic_tool",
          toolName: "goat.goat_screen_run",
          input: { code: "..." },
          ...(output === undefined ? {} : { output }),
        });
        const ingest = (
          turnItem: OrchestrationV2TurnItem,
          callApps: ReturnType<typeof makeCallApps>,
        ) =>
          ingestor
            .ingestNormalized({
              providerSessionId,
              providerInstanceId: modelSelection.instanceId,
              threadId,
              event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem },
            })
            .pipe(Effect.provideService(ComputerUseCallApps, callApps));
        const stored = (id: string) =>
          projectionStore.getTurnItem({ threadId, itemId: TurnItemId.make(id) });

        yield* eventSink.write({ events: [threadEvent] });
        const before = makeCallApps();
        before.screenRow(
          "cell-1",
          { threadId, title: "Terminal · type, press Enter", summary: "2 confirmed · 820 ms" },
          yield* Clock.currentTimeMillis,
        );
        yield* ingest(cellRow("screen-row", "completed", { cellId: "cell-1" }), before);

        // A restarted server remembers no cells; the stored row is all it has.
        const after = makeCallApps();
        for (const update of [
          cellRow("screen-row", "completed", "Ran the screen cell."),
          cellRow("screen-row", "running"),
          cellRow("screen-row", "pending"),
        ]) {
          yield* ingest(update, after);
          const row = yield* stored("screen-row");
          assert.equal(row?.title, "Terminal · type, press Enter");
          assert.equal(
            row?.type === "dynamic_tool" ? row.toolSummary : undefined,
            "2 confirmed · 820 ms",
          );
        }

        // A fresh row has nothing resolved to keep.
        yield* ingest(cellRow("fresh-row", "running"), after);
        const fresh = yield* stored("fresh-row");
        assert.equal(fresh?.title, "goat screen run");
        assert.equal(fresh?.type === "dynamic_tool" ? fresh.toolSummary : "", undefined);
      }),
  );
});
