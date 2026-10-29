// @effect-diagnostics-next-line nodeBuiltinImport:off -- fallback claim ids need a random UUID.
import * as NodeCrypto from "node:crypto";
import {
  ChannelReceptionId,
  type ChannelInputId,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import * as ChannelBotSession from "./ChannelBotSession.ts";
import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelWake from "./ChannelWake.ts";
import { resolveSessionRun } from "./channelBotSessionRuns.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { deliveryIdFor, taskIdFor } from "./channelIds.ts";
import { isSessionClaim, sealedSessionLine, sessionClaim } from "./channelSessionReceipt.ts";
import { makeCreatedTasks } from "./channelTaskWrites.ts";
import { WORKERS_PER_REQUESTER } from "./ChannelDispatcher.ts";

export class ChannelSessionFirst extends Context.Service<
  ChannelSessionFirst,
  {
    readonly offer: (
      inputId: ChannelInputId,
      owner: string,
    ) => Effect.Effect<boolean, ChannelLedger.ChannelLedgerError>;
    readonly observe: (
      owner: string,
      event?: OrchestrationV2DomainEvent,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    readonly deadlines: (owner: string) => Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
    readonly settle: (ids: ReadonlyArray<ChannelInputId>) => Effect.Effect<void>;
  }
>()("goat/channels/ChannelSessionFirst") {}

const isLedgerError = Schema.is(ChannelLedger.ChannelLedgerError);
const mapError = (cause: unknown) =>
  isLedgerError(cause)
    ? cause
    : new ChannelLedger.ChannelLedgerError({
        reason: "persistence",
        detail: "session first receipt",
        cause,
      });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const sessions = yield* ChannelBotSession.ChannelBotSession;
  const reception = yield* ChannelReceptionService.ChannelReceptionService;
  const delivery = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const home = yield* ChannelBotHome.ChannelBotHome;
  const wake = yield* ChannelWake.ChannelWake;
  const scope = yield* Effect.scope;
  const acknowledgments = new Map<ChannelInputId, Fiber.Fiber<void, unknown>>();
  const ackStarted = new Set<ChannelInputId>();
  const scheduled = new Set<string>();

  const commit = Effect.fn("ChannelSessionFirst.commit")(function* (
    stored: ChannelLedger.ChannelStoredInput,
    owner: string,
    source: "session" | "fallback" | "fixed",
    text: string,
    runId?: string,
    turnItemId?: string,
  ) {
    const inputId = stored.snapshot.inputId;
    const expected = stored.snapshot.receptionId;
    if (!isSessionClaim(expected) || expected === undefined) return false;
    const causeKey = "reply:" + inputId;
    const deliveryId = deliveryIdFor(causeKey);
    const taskId = taskIdFor(inputId, 0);
    const destination = stored.message.replyAddress;
    const actor = stored.message.actor.externalActorId;
    const committed = yield* ledger.commitSessionReceipt({
      owner,
      inputId,
      expectedReceptionId: expected,
      taskId,
      source,
      text,
      runId,
      turnItemId,
      now: DateTime.formatIso(yield* DateTime.now),
      deliveries: [
        {
          causeKey,
          deliveryId,
          inputId,
          taskId,
          message: {
            deliveryId,
            destination,
            kind: "receipt",
            text,
            inReplyToInputId: inputId,
            ...(destination.kind === "slack" && actor !== undefined
              ? { mentionActorId: actor }
              : {}),
          },
        },
      ],
    });
    if (committed) {
      yield* delivery.deliverReceipts(owner);
      yield* wake.wake;
    }
    return committed;
  });

  const offer = Effect.fn("ChannelSessionFirst.offer")(function* (
    inputId: ChannelInputId,
    owner: string,
  ) {
    const stored = yield* ledger.getInput(inputId);
    if (
      stored === undefined ||
      stored.snapshot.state !== "accepted" ||
      stored.requester === undefined ||
      stored.message.intent !== "message" ||
      /^link\s/iu.test(stored.message.text)
    )
      return false;
    const requester = stored.requester;
    if (
      requester.originKind === "mcp" ||
      !requester.grantedScopes.includes("orchestration:operate")
    )
      return false;
    if (
      !(yield* home.requireHome.pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ))
    )
      return false;
    const open =
      yield* sql`SELECT 1 FROM channel_tasks t WHERE t.conversation_id = ${stored.snapshot.conversationId}
      AND (t.status IN ('received', 'dispatching', 'running', 'waiting_input') OR EXISTS (
        SELECT 1 FROM channel_outbox o WHERE o.task_id = t.task_id AND o.kind IN ('result', 'failure')
          AND o.state IN ('pending', 'delivering')) OR EXISTS (
        SELECT 1 FROM channel_task_events e WHERE e.task_id = t.task_id
          AND e.type IN ('task.completed', 'task.failed', 'task.cancelled') AND e.narration_state = 'pending')) LIMIT 1`;
    if (
      open.length > 0 ||
      (yield* ledger.countBusyTasks({
        ownerId: requester.ownerId,
        principalId: requester.principalId,
      })) >= WORKERS_PER_REQUESTER
    )
      return false;
    const now = DateTime.formatIso(yield* DateTime.now);
    const [createdTask] = makeCreatedTasks({
      action: {
        type: "run_turn",
        title:
          stored.message.text.trim().split(/\s+/u).slice(0, 12).join(" ").slice(0, 120) ||
          "Request",
        instruction: stored.message.text,
      },
      inputId,
      conversationId: stored.snapshot.conversationId,
      originBindingId: stored.snapshot.bindingId,
      originAddress: stored.message.replyAddress,
      requester,
      now,
    });
    if (createdTask === undefined || !(yield* sessions.eligible(createdTask.task))) return false;
    const claimed = yield* ledger.claimForSession({
      owner,
      inputId,
      now,
      createdTask,
      receptionId: ChannelReceptionId.make(sessionClaim(inputId)),
    });
    if (claimed) yield* schedule(stored, owner);
    return claimed;
  }, Effect.mapError(mapError));

  const observe = Effect.fn("ChannelSessionFirst.observe")(function* (
    owner: string,
    event?: OrchestrationV2DomainEvent,
  ) {
    if (event !== undefined && event.type !== "turn-item.updated" && event.type !== "run.updated")
      return;
    const rows = yield* sql<{
      readonly input_id: ChannelInputId;
    }>`SELECT input_id FROM channel_inbox
      WHERE state = 'processing' AND reception_id LIKE 'channel-session:%'`;
    for (const row of rows) {
      const stored = yield* ledger.getInput(row.input_id);
      const task = yield* ledger.getTask(taskIdFor(row.input_id, 0));
      if (stored === undefined || task === undefined) continue;
      const intents = yield* sql<{ readonly thread_id: ThreadId }>`SELECT DISTINCT thread_id
        FROM channel_bot_session_runs WHERE task_id = ${task.task.taskId}
          AND task_generation = ${task.task.generation}`;
      for (const { thread_id: threadId } of intents) {
        if (event !== undefined && event.threadId !== threadId) continue;
        const records = yield* threads.getThreadRecords(threadId, [
          "runs",
          "messages",
          "turnItems",
        ]);
        const items =
          event?.type === "turn-item.updated"
            ? [...records.turnItems.filter((item) => item.id !== event.payload.id), event.payload]
            : records.turnItems;
        for (const item of items.toSorted((a, b) => a.ordinal - b.ordinal)) {
          if (
            item.type !== "assistant_message" ||
            item.runId === null ||
            item.parentItemId !== null
          )
            continue;
          const intent = yield* resolveSessionRun(sql, threadId, records, item.runId);
          if (
            intent?.task_id !== task.task.taskId ||
            intent.task_generation !== task.task.generation
          )
            continue;
          const boundary = records.turnItems.some(
            (next) =>
              next.runId === item.runId &&
              next.ordinal > item.ordinal &&
              next.type !== "assistant_message" &&
              next.type !== "reasoning",
          );
          const line = sealedSessionLine(item.text, item.streaming && !boundary);
          if (line === undefined) break;
          yield* commit(stored, owner, "session", line, item.runId, item.id);
          break;
        }
      }
    }
  }, Effect.mapError(mapError));

  const startAck = Effect.fn("ChannelSessionFirst.startAck")(function* (
    stored: ChannelLedger.ChannelStoredInput,
    owner: string,
  ) {
    const inputId = stored.snapshot.inputId;
    if (ackStarted.has(inputId) || stored.requester === undefined) return;
    const task = yield* ledger.getTask(taskIdFor(inputId, 0));
    if (task === undefined) return;
    ackStarted.add(inputId);
    const fiber = yield* reception
      .acknowledgeSession({
        mode: "task_event",
        conversationId: stored.snapshot.conversationId,
        originKind: stored.requester.originKind,
        requester: stored.requester,
        taskEvent: {
          taskId: task.task.taskId,
          type: "task.started",
          summary: "Work on the request has begun: " + task.task.instruction.slice(0, 500),
        },
        tail: [{ role: "user", text: stored.message.text, at: stored.message.receivedAt }],
        tasks: [],
        allowedTargets: [],
      })
      .pipe(
        Effect.flatMap((text) =>
          text === undefined ? Effect.void : commit(stored, owner, "fallback", text),
        ),
        Effect.asVoid,
        Effect.tapCause((cause) =>
          Effect.logWarning("channel session acknowledgment failed", { inputId, cause }),
        ),
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            acknowledgments.delete(inputId);
          }),
        ),
        Effect.forkIn(scope),
      );
    acknowledgments.set(inputId, fiber);
  });

  const deadlines: ChannelSessionFirst["Service"]["deadlines"] = Effect.fn(
    "ChannelSessionFirst.deadlines",
  )(function* (owner: string) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const rows = yield* sql<{
      readonly input_id: ChannelInputId;
    }>`SELECT input_id FROM channel_inbox
      WHERE state = 'processing' AND (reception_id LIKE 'channel-session:%' OR reception_id LIKE 'channel-session-ack:%')`;
    let changed = 0;
    for (const row of rows) {
      let stored = yield* ledger.getInput(row.input_id);
      if (stored === undefined) continue;
      yield* schedule(stored, owner);
      const age = now - Date.parse(stored.snapshot.acceptedAt);
      if (age >= 55_000) {
        if (yield* commit(stored, owner, "fixed", CHANNEL_COPY.sessionWorking)) {
          changed += 1;
          const fiber = acknowledgments.get(row.input_id);
          if (fiber !== undefined) yield* Fiber.interrupt(fiber).pipe(Effect.forkIn(scope));
        }
        continue;
      }
      if (age < 20_000) continue;
      if (stored.snapshot.receptionId === sessionClaim(row.input_id)) {
        const expected = stored.snapshot.receptionId;
        if (
          !(yield* ledger.takeSessionAcknowledgment({
            owner,
            inputId: row.input_id,
            expectedReceptionId: expected,
            receptionId: ChannelReceptionId.make(
              "channel-session-ack:" + row.input_id + ":" + NodeCrypto.randomUUID(),
            ),
          }))
        )
          continue;
        changed += 1;
        stored = yield* ledger.getInput(row.input_id);
      }
      if (stored !== undefined) yield* startAck(stored, owner);
    }
    return changed;
  }, Effect.mapError(mapError));

  const schedule = Effect.fn("ChannelSessionFirst.schedule")(function* (
    stored: ChannelLedger.ChannelStoredInput,
    owner: string,
  ) {
    const key = owner + ":" + stored.snapshot.inputId;
    if (scheduled.has(key)) return;
    scheduled.add(key);
    const accepted = Date.parse(stored.snapshot.acceptedAt);
    for (const delay of [20_000, 55_000, 60_000]) {
      const remaining = accepted + delay - DateTime.toEpochMillis(yield* DateTime.now);
      yield* Effect.sleep(Math.max(0, remaining)).pipe(
        Effect.andThen(
          delay === 60_000
            ? Effect.flatMap(DateTime.now, (now) =>
                ledger.expireReceipts({ owner, now: DateTime.formatIso(now) }),
              )
            : deadlines(owner),
        ),
        Effect.tapCause((cause) => Effect.logWarning("channel session deadline failed", { cause })),
        Effect.ignore,
        Effect.ensuring(
          delay === 60_000
            ? Effect.sync(() => {
                scheduled.delete(key);
                ackStarted.delete(stored.snapshot.inputId);
              })
            : Effect.void,
        ),
        Effect.forkIn(scope),
      );
    }
  });

  const settle = (ids: ReadonlyArray<ChannelInputId>) =>
    Effect.forEach(
      ids,
      (id) => {
        const fiber = acknowledgments.get(id);
        return fiber === undefined ? Effect.void : Fiber.await(fiber).pipe(Effect.asVoid);
      },
      { discard: true },
    );
  return ChannelSessionFirst.of({ offer, observe, deadlines, settle });
});

export const layer = Layer.effect(ChannelSessionFirst, make);
