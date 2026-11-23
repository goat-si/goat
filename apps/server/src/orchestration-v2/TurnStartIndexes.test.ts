import { assert, it } from "@effect/vitest";
import {
  ContextHandoffId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  layerTest,
  driver,
  providerInstanceId,
  traceSqlStatements,
  addRolledBackRecoveryCandidate,
} from "./ProjectionStore.testkit.ts";

it.layer(layerTest)("turn-start indexed reads", (it) => {
  it.effect(
    "a turn start reads a long thread's deferred commands, routable tasks and fork by index",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const threadId = yield* addRolledBackRecoveryCandidate("turn-start-commands");
        const runId = RunId.make("run:turn-start-commands:rolled-back");
        const created = yield* DateTime.now;
        const nowIso = DateTime.formatIso(created);
        const message = (id: string, role: "user" | "assistant", text: string, minutes: number) =>
          projectionStore.apply({
            id: EventId.make(`event:${id}`),
            type: "message.updated",
            threadId,
            occurredAt: created,
            payload: {
              id: MessageId.make(id),
              threadId,
              runId: null,
              nodeId: null,
              role,
              text,
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "web",
              createdAt: DateTime.add(created, { minutes }),
              updatedAt: DateTime.add(created, { minutes }),
            },
          });
        yield* message("message:turn-start-commands:rolled-back", "user", "Own prompt", 5);
        yield* message("message:turn-start-commands:compact", "user", "\u00a0 /Compact\n", 1);
        yield* message("message:turn-start-commands:goal", "user", "/goal ship it", 2);
        yield* message("message:turn-start-commands:plain", "user", "Plain prompt", 3);
        yield* message("message:turn-start-commands:later", "user", "/compact later", 4);
        yield* message("message:turn-start-commands:assistant", "assistant", "/compact", 6);

        const otherThreadId = ThreadId.make("thread:other");
        const transfer = (id: string, type: "fork" | "merge_back") =>
          projectionStore.apply({
            id: EventId.make(`event:${id}`),
            type: "context-transfer.created",
            threadId,
            occurredAt: created,
            payload: {
              id: ContextTransferId.make(id),
              type,
              sourceThreadId: otherThreadId,
              targetThreadId: threadId,
              sourcePoint: { threadId: otherThreadId },
              basePoint: null,
              sourceProviderInstanceId: providerInstanceId,
              targetProviderInstanceId: providerInstanceId,
              targetRunId: null,
              status: "pending",
              resolution: null,
              createdBy: "user",
              error: null,
              createdAt: created,
              updatedAt: created,
              consumedAt: null,
            },
          });
        yield* transfer("transfer:turn-start-commands:fork", "fork");
        yield* transfer("transfer:turn-start-commands:referenced", "merge_back");
        yield* projectionStore.apply({
          id: EventId.make("event:turn-start-commands:handoff"),
          type: "context-handoff.updated",
          threadId,
          occurredAt: created,
          payload: {
            id: ContextHandoffId.make("handoff:turn-start-commands"),
            transferId: ContextTransferId.make("transfer:turn-start-commands:referenced"),
            threadId,
            targetRunId: runId,
            fromProviderThreadIds: [],
            toProviderThreadId: ProviderThreadId.make("provider-thread:turn-start-commands"),
            coveredRunOrdinals: { from: 1, to: 1 },
            strategy: "full_thread_summary",
            status: "ready",
            summaryMessageId: null,
            summaryText: "Summary",
            createdByProviderInstanceId: providerInstanceId,
            createdAt: created,
            updatedAt: created,
          },
        });
        const nativeId = NodeId.make("subagent:turn-start-commands:native");
        yield* projectionStore.apply({
          id: EventId.make("event:turn-start-commands:native"),
          type: "subagent.updated",
          threadId,
          runId,
          nodeId: nativeId,
          driver,
          providerInstanceId,
          occurredAt: created,
          payload: {
            id: nativeId,
            threadId,
            runId,
            parentNodeId: NodeId.make("node:turn-start-commands:rolled-back"),
            status: "completed",
            startedAt: created,
            completedAt: created,
            origin: "provider_native",
            createdBy: "agent",
            driver,
            providerInstanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Do the work",
            title: "native",
            model: null,
            completionDelivery: { state: "delivered", observedByRunId: null },
            result: null,
            updatedAt: created,
          },
        });
        yield* sql`
        INSERT INTO orchestration_v2_projection_subagents (
          subagent_id, thread_id, run_id, parent_node_id, provider, origin, status, updated_at,
          payload_json
        ) VALUES
          ('subagent:turn-start-commands:delegated', ${threadId}, NULL, 'node', 'codex',
           'app_owned', 'completed', ${nowIso}, '{}'),
          ('subagent:turn-start-commands:running', ${threadId}, NULL, 'node', 'codex',
           'provider_native', 'running', ${nowIso}, '{}')
      `;
        yield* sql`
        INSERT INTO orchestration_v2_projection_context_transfers (
          context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at,
          payload_json
        ) VALUES
          ('transfer:turn-start-commands:result', 'thread:other', ${threadId},
           'subagent_result', 'consumed', ${nowIso}, '{}'),
          ('transfer:turn-start-commands:other-fork', ${threadId}, 'thread:other',
           'fork', 'pending', ${nowIso}, '{}')
      `;

        const { statements, tracer } = traceSqlStatements();
        const context = yield* projectionStore
          .getTurnStartContext(threadId, runId)
          .pipe(Effect.withTracer(tracer));
        assert.deepEqual(
          context.messages.map((item) => item.id),
          [
            "message:turn-start-commands:compact",
            "message:turn-start-commands:goal",
            "message:turn-start-commands:later",
            "message:turn-start-commands:rolled-back",
          ],
        );
        assert.deepEqual(
          context.subagents.map((task) => task.id),
          [nativeId],
        );
        assert.deepEqual(
          context.contextTransfers.map((item) => item.id),
          ["transfer:turn-start-commands:fork", "transfer:turn-start-commands:referenced"],
        );

        const planOf = Effect.fn("planOf")(function* (table: string) {
          const statement = statements.find((query) =>
            query.includes(`FROM orchestration_v2_projection_${table}`),
          )!;
          const params = Array.from({ length: statement.split("?").length - 1 }, () => threadId);
          return (yield* sql.unsafe<{ readonly detail: string }>(
            `EXPLAIN QUERY PLAN ${statement}`,
            params,
          )).map((row) => row.detail);
        });
        for (const [table, index] of [
          ["messages", "orchestration_v2_projection_messages_deferred_command_idx"],
          ["subagents", "orchestration_v2_projection_subagents_routable_idx"],
          ["context_transfers", "orchestration_v2_projection_context_transfers_fork_idx"],
        ] as const) {
          const plan = yield* planOf(table);
          assert.isTrue(
            plan.some((detail) => detail.includes(index)),
            `${table}\n${plan.join("\n")}`,
          );
        }
      }),
  );
});
