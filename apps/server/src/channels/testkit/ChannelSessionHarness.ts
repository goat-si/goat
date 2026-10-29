import {
  MessageId,
  ProviderDriverKind,
  TurnItemId,
  type ChannelTask,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ChannelLayers from "../ChannelLayers.ts";
import { makeHarness } from "./ChannelHarness.ts";

export const makeSessionHarness = (options: { readonly driver?: "opencode" } = {}) => {
  const items = new Map<ThreadId, OrchestrationV2TurnItem[]>();
  const layer = Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const service = yield* ThreadManagement.ThreadManagementService;
      return ThreadManagement.ThreadManagementService.of({
        ...service,
        getThreadRecords: Effect.fn("SessionHarness.getThreadRecords")((threadId, fields, filter) =>
          service.getThreadRecords(threadId, fields, filter).pipe(
            Effect.map((records) => {
              const own = items.get(threadId);
              if (own === undefined) return records;
              return {
                ...records,
                turnItems: [
                  ...("turnItems" in records
                    ? (records.turnItems as ReadonlyArray<OrchestrationV2TurnItem>)
                    : []),
                  ...own,
                ],
                messages: own.flatMap((item) =>
                  item.type !== "assistant_message"
                    ? []
                    : [
                        {
                          id: item.messageId,
                          threadId,
                          runId: item.runId,
                          nodeId: null,
                          role: "assistant" as const,
                          text: item.text,
                          streaming: item.streaming,
                          attachments: [],
                          createdAt: item.updatedAt,
                          updatedAt: item.updatedAt,
                        },
                      ],
                ),
              };
            }),
          ),
        ),
      });
    }),
  );
  const providerLayer =
    options.driver === undefined
      ? Layer.empty
      : Layer.effect(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          Effect.gen(function* () {
            const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
            return ProviderInstanceRegistry.ProviderInstanceRegistry.of({
              ...registry,
              getInstance: Effect.fn("SessionHarness.getInstance")((id) =>
                registry.getInstance(id).pipe(
                  Effect.map((instance) =>
                    instance === undefined
                      ? undefined
                      : {
                          ...instance,
                          driverKind: ProviderDriverKind.make(options.driver ?? "codex"),
                        },
                  ),
                ),
              ),
            });
          }),
        );
  const harness = makeHarness({
    botWorkspace: true,
    channelsLayer: ChannelLayers.layerServices.pipe(
      Layer.provide(layer),
      Layer.provide(providerLayer),
    ),
  });
  const assistant = (task: ChannelTask, text: string, streaming = false, ordinal = 0) => {
    const worker = task.worker;
    if (worker === undefined) throw new Error("The task has no session worker");
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("item:" + task.taskId + ":" + ordinal),
      type: "assistant_message",
      threadId: worker.threadId,
      runId: worker.runId ?? null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: streaming ? "running" : "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe(0),
      messageId: MessageId.make("message:" + task.taskId + ":" + ordinal),
      text,
      streaming,
    };
    const prior = items.get(worker.threadId) ?? [];
    items.set(worker.threadId, [...prior.filter((other) => other.id !== item.id), item]);
    return item;
  };
  return {
    ...harness,
    layer: Layer.mergeAll(layer, providerLayer).pipe(Layer.provideMerge(harness.layer)),
    assistant,
  };
};
