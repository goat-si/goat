import {
  ChannelTaskExportRow,
  ChannelTaskLedgerExportRow,
  type ChannelTaskExportInput,
  type ChannelTaskExportResult,
  type ChannelTaskMemoryDelivered,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as MemoryStore from "../memory/MemoryStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { answerForwardIdsFor } from "./channelIds.ts";

export class ChannelTaskExport extends Context.Service<
  ChannelTaskExport,
  {
    readonly exportTasks: (
      input: ChannelTaskExportInput & { readonly ownerId: string },
    ) => Effect.Effect<ChannelTaskExportResult, ChannelLedger.ChannelLedgerError>;
  }
>()("goat/channels/ChannelTaskExport") {}

const decodeLedgerRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ChannelTaskLedgerExportRow),
);
const encodeRow = Schema.encodeSync(Schema.fromJsonString(ChannelTaskExportRow));
const unknownMemory: ChannelTaskMemoryDelivered = { state: "unknown", revisions: [] };

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const events = yield* EventSink.EventSinkV2;
  // Partial embeddings can omit memory readers. Unknown must not masquerade as complete evidence.
  const memory = yield* Effect.serviceOption(MemoryStore.MemoryStore);
  const settings = yield* Effect.serviceOption(ServerSettings.MemoryHubCommittedSettings);

  const threadAnswers = Effect.fn("channel.export.threadAnswers")(
    function* (row: ChannelTaskLedgerExportRow) {
      const worker = row.evidence;
      if (worker === null || worker.host !== undefined || worker.generation !== row.generation)
        return null;
      const answerIds = yield* ledger.answerEventIdsThrough(row.taskId, row.sequence);
      if (answerIds.overflow) return null;
      const forwardedRequests = new Set<string>();
      // Channel forwarding uses a deterministic command id. Only matching persisted resolutions
      // are duplicates; equal answer text or nearby timestamps are not proof of the same answer.
      for (const eventId of answerIds.eventIds) {
        const forwarded = yield* events
          .readByCommandId({ commandId: answerForwardIdsFor(eventId).commandId })
          .pipe(Stream.runCollect);
        for (const stored of forwarded) {
          const event = stored.event;
          if (
            event.threadId === worker.threadId &&
            event.type === "runtime-request.updated" &&
            event.payload.status === "resolved"
          ) {
            forwardedRequests.add(event.payload.id);
          }
        }
      }
      const projection = yield* threads.getThreadRecords(worker.threadId, ["runtimeRequests"]);
      const terminalAt = Date.parse(row.occurredAt);
      return new Set(
        projection.runtimeRequests
          .filter((request) => {
            const responder = request.respondedBy;
            return (
              request.kind === "user_input" &&
              request.status === "resolved" &&
              request.answers !== undefined &&
              request.resolvedAt !== null &&
              DateTime.toEpochMillis(request.resolvedAt) <= terminalAt &&
              (responder?.type === "user" ||
                (responder?.type === "agent" && responder.relayedFromUser === true)) &&
              !forwardedRequests.has(request.id)
            );
          })
          .map((request) => request.id),
      ).size;
    },
    Effect.catch(() => Effect.succeed(null)),
  );

  const memoryDelivered = Effect.fn("channel.export.memoryDelivered")(
    function* (row: ChannelTaskLedgerExportRow) {
      const worker = row.evidence;
      if (
        worker === null ||
        worker.host !== undefined ||
        memory._tag === "None" ||
        settings._tag === "None"
      )
        return unknownMemory;
      const binding = (yield* settings.value.read).settings;
      if (binding.mode === "disabled" || binding.memorySpaceId === null) return unknownMemory;
      // Export-time observation, not an outcome-time snapshot. Lineage is cumulative for this
      // thread, includes ancestors of consumed revisions, and does not prove reliance by this run.
      const lineage = yield* memory.value.readThreadLineage(
        { environmentId: worker.environmentId, threadId: worker.threadId },
        binding.memorySpaceId,
      );
      return { state: lineage.state, revisions: lineage.revisions };
    },
    Effect.catch(() => Effect.succeed(unknownMemory)),
  );

  return ChannelTaskExport.of({
    exportTasks: Effect.fn("channel.exportTasks")(function* (input) {
      const page = yield* ledger.exportTasks(input);
      const lines = yield* Effect.forEach(
        page.jsonl.split("\n").filter((line) => line.length > 0),
        (line) =>
          Effect.gen(function* () {
            const row = yield* decodeLedgerRow(line).pipe(
              Effect.mapError(
                (cause) =>
                  new ChannelLedger.ChannelLedgerError({
                    reason: "persistence",
                    detail: "Invalid channel export source row.",
                    cause,
                  }),
              ),
            );
            const { channelAnswers, ...outcome } = row;
            return encodeRow({
              ...outcome,
              humanInterventions: { channelAnswers, threadAnswers: yield* threadAnswers(row) },
              memoryDelivered: yield* memoryDelivered(row),
            });
          }),
      );
      return { ...page, jsonl: lines.length === 0 ? "" : lines.join("\n") + "\n" };
    }),
  });
});

export const layer = Layer.effect(ChannelTaskExport, make);
