import {
  MessageId,
  ProviderDriverKind,
  TurnItemId,
  type ChannelTask,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
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
  const wakes = new Map<ThreadId, OrchestrationV2ThreadProjection["messages"][number][]>();
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
              const delegated = wakes.get(threadId);
              if (own === undefined && delegated === undefined) return records;
              return {
                ...records,
                turnItems: [
                  ...("turnItems" in records
                    ? (records.turnItems as ReadonlyArray<OrchestrationV2TurnItem>)
                    : []),
                  ...(own ?? []),
                ],
                messages: [
                  // Base user messages stay: a background command's notice is one.
                  ...("messages" in records
                    ? (records.messages as OrchestrationV2ThreadProjection["messages"]).filter(
                        (message) => message.role === "user",
                      )
                    : []),
                  ...(delegated ?? []),
                  ...(own ?? []).flatMap((item) =>
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
                ],
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
  /** A command the session's provider ran, as a work item of the task's run. */
  const tool = (task: ChannelTask, command: string, ordinal = 0) => {
    const worker = task.worker;
    if (worker === undefined) throw new Error("The task has no session worker");
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("tool:" + task.taskId + ":" + ordinal),
      type: "command_execution",
      threadId: worker.threadId,
      runId: worker.runId ?? null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "running",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe(0),
      input: command,
    };
    const prior = items.get(worker.threadId) ?? [];
    items.set(worker.threadId, [...prior.filter((other) => other.id !== item.id), item]);
    return item;
  };
  const delegatedWake = (parent: OrchestrationV2Run) => {
    const { threadId } = parent;
    const now = DateTime.makeUnsafe(0);
    const messageId = MessageId.make("delegated-completion:" + parent.id);
    const run = harness.world.addRun(threadId, messageId);
    wakes.set(threadId, [
      ...(wakes.get(threadId) ?? []),
      {
        id: messageId,
        threadId,
        runId: run.id,
        nodeId: null,
        role: "user",
        text: "Delegated work finished.",
        createdBy: "agent",
        creationSource: "server",
        streaming: false,
        attachments: [],
        createdAt: now,
        updatedAt: now,
        delegatedCompletion: { parentRunId: parent.id, generation: 1, taskIds: [] },
      },
    ]);
    return run;
  };
  return {
    ...harness,
    layer: Layer.mergeAll(layer, providerLayer).pipe(Layer.provideMerge(harness.layer)),
    assistant,
    tool,
    delegatedWake,
  };
};
