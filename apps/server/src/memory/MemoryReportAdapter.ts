import type * as M from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ChannelBotRegistry from "../channels/ChannelBotRegistry.ts";
import * as ChannelBotTimeline from "../channels/ChannelBotTimeline.ts";
import { conversationIdFor } from "../channels/channelIds.ts";
import { channelOwnerIdFor } from "../channels/channelOwner.ts";
import * as MemoryService from "./MemoryService.ts";

export class MemoryReportAdapterError extends Schema.TaggedError<MemoryReportAdapterError>()(
  "MemoryReportAdapterError",
  { code: Schema.Literals(["unavailable", "storage_failed"]) },
) {}

export class MemoryReportAdapter extends Context.Service<
  MemoryReportAdapter,
  {
    readonly deliver: (
      report: M.MemoryReportDelivery,
    ) => Effect.Effect<M.MemoryReportDelivery, MemoryReportAdapterError>;
  }
>()("goat/memory/MemoryReportAdapter") {}

// Copy and revision depend only on the durable outcome, never retained memory content.
const outcomes = {
  resolved: { text: "A memory conflict was resolved.", revision: "resolved", kind: "result" },
  reverted: { text: "A memory resolution was reverted.", revision: "reverted", kind: "result" },
  failed: { text: "A memory conflict could not be resolved.", revision: "failed", kind: "failure" },
} as const;

const make = Effect.gen(function* () {
  const service = yield* MemoryService.MemoryService;
  const bots = yield* ChannelBotRegistry.ChannelBotRegistry;
  const timeline = yield* ChannelBotTimeline.ChannelBotTimeline;
  return MemoryReportAdapter.of({
    deliver: (report) =>
      Effect.gen(function* () {
        const target = yield* service
          .readReportTarget(report.reportId)
          .pipe(Effect.mapError(() => new MemoryReportAdapterError({ code: "storage_failed" })));
        if (!target || target.deliveryEnvironmentId !== report.resolvingEnvironmentId)
          return yield* new MemoryReportAdapterError({ code: "unavailable" });
        const bot = yield* bots
          .ensureForReport(target.deliveryEnvironmentId)
          .pipe(Effect.mapError(() => new MemoryReportAdapterError({ code: "unavailable" })));
        const outcome = outcomes[report.outcome];
        const sequence = yield* timeline
          .record({
            threadId: bot.threadId,
            record: {
              recordKey: `memory-report:${report.reportId}`,
              entry: {
                type: "message",
                role: "assistant",
                text: outcome.text,
                meta: {
                  conversationId: conversationIdFor({
                    ownerId: channelOwnerIdFor(target.deliveryEnvironmentId),
                    kind: "goat",
                    connectionId: "goat",
                    conversationKey: bot.threadId,
                  }),
                  originKind: "goat",
                  kind: outcome.kind,
                  memory: {
                    memorySpaceId: target.memorySpaceId,
                    environmentId: target.deliveryEnvironmentId,
                    memoryId: target.memoryId,
                    ...(report.resolutionId === null ? {} : { resolutionId: report.resolutionId }),
                  },
                },
              },
            },
            revision: outcome.revision,
          })
          .pipe(Effect.mapError(() => new MemoryReportAdapterError({ code: "storage_failed" })));
        return {
          ...report,
          state: "delivered" as const,
          reportThread: { environmentId: target.deliveryEnvironmentId, threadId: bot.threadId },
          sequence,
        };
      }),
  });
});
export const layer = Layer.effect(MemoryReportAdapter, make);
