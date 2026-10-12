import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelAnswerProjectChoice,
  ChannelInboundMessage,
  ProjectId,
  ChannelOutboundMessage,
  ChannelRequester,
  ChannelTask,
  ChannelTaskEvent,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import {
  bindingIdFor,
  contentHashFor,
  conversationIdFor,
  deliveryIdFor,
  inputIdFor,
  linkCodeHashFor,
  taskEventIdFor,
  taskIdFor,
} from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { applyChannelTaskEvent } from "./channelTaskTransitions.ts";

const decodeMessage = Schema.decodeUnknownSync(ChannelInboundMessage);
const decodeRequester = Schema.decodeUnknownSync(ChannelRequester);
const decodeTask = Schema.decodeUnknownSync(ChannelTask);
const decodeEvent = Schema.decodeUnknownSync(ChannelTaskEvent);
const decodeOutbound = Schema.decodeUnknownSync(ChannelOutboundMessage);

const TestLayer = ChannelLedger.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const NOW = "2026-10-12T00:00:00.000Z";

const slackMessage = (overrides: Record<string, unknown> = {}) =>
  decodeMessage({
    kind: "slack",
    connectionId: "slack-1",
    conversationKey: "T1:C1:1760000000.000100",
    externalMessageId: "1760000000.000200",
    idempotencyKey: "T1:Ev1",
    actor: { externalActorId: "U1" },
    replyAddress: {
      kind: "slack",
      connectionId: "slack-1",
      teamId: "T1",
      channelId: "C1",
      rootTs: "1760000000.000100",
    },
    text: "Re-verify the Opus 5.5 call",
    attachments: [],
    receivedAt: NOW,
    intent: "message",
    ...overrides,
  });

const requester = decodeRequester({
  ownerId: "owner",
  principalId: "owner",
  displayName: "Jun",
  originKind: "slack",
  externalActorId: "U1",
  runtimeModeCeiling: "approval-required",
  grantedScopes: ["orchestration:read", "orchestration:operate"],
});

const accept = (message = slackMessage(), withRequester = true) => {
  const conversationId = conversationIdFor({
    ownerId: "owner",
    kind: message.kind,
    connectionId: message.connectionId,
    conversationKey: message.conversationKey,
  });
  return ChannelLedger.ChannelLedger.pipe(
    Effect.flatMap((ledger) =>
      ledger.acceptInput({
        ownerId: "owner",
        inputId: inputIdFor({
          ownerId: "owner",
          kind: message.kind,
          connectionId: message.connectionId,
          idempotencyKey: message.idempotencyKey,
        }),
        conversationId,
        bindingId: bindingIdFor(conversationId, "root"),
        message,
        contentHash: contentHashFor(message),
        requester: withRequester ? requester : undefined,
        acceptedAt: NOW,
      }),
    ),
  );
};

const claimOwner = (token: string, now: string, staleBefore: string) =>
  ChannelLedger.ChannelLedger.pipe(
    Effect.flatMap((ledger) => ledger.claimOwnership({ token, now, staleBefore })),
  );

const newTask = (inputId: string, conversationId: string, bindingId: string) => {
  const taskId = taskIdFor(inputId as never, 0);
  const task = decodeTask({
    taskId,
    conversationId,
    originBindingId: bindingId,
    originAddress: slackMessage().replyAddress,
    originInputId: inputId,
    requester,
    title: "Re-verify the call",
    instruction: "Run it again.",
    status: "received",
    version: 1,
    generation: 1,
    openQuestions: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const event = decodeEvent({
    eventId: taskEventIdFor(taskId, 1),
    sequence: 0,
    taskId,
    taskVersion: 1,
    occurredAt: NOW,
    actor: "system",
    type: "task.created",
    payload: { title: task.title, instruction: task.instruction, originInputId: inputId },
  });
  return { task, event };
};

describe("ChannelLedger inputs", () => {
  it.effect("returns the stored input for a repeated key and refuses different content", () =>
    Effect.gen(function* () {
      const first = yield* accept();
      const again = yield* accept();
      assert.isFalse(first.duplicate);
      assert.isTrue(again.duplicate);
      assert.strictEqual(again.inputId, first.inputId);
      assert.strictEqual(first.state, "accepted");
      const conflict = yield* Effect.flip(accept(slackMessage({ text: "something else" })));
      assert.strictEqual(conflict.reason, "idempotency_conflict");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stores an input without a requester as rejected", () =>
    Effect.gen(function* () {
      const result = yield* accept(slackMessage({ idempotencyKey: "T1:Ev2" }), false);
      assert.strictEqual(result.state, "rejected");
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.deepStrictEqual(yield* ledger.listPendingInputs(10), []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("lets only the reception pass that began an input complete it", () =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.isTrue(yield* claimOwner("owner-a", NOW, "2026-10-11T23:59:30.000Z"));
      const accepted = yield* accept();
      const first = yield* ledger.beginReception({
        owner: "owner-a",
        inputId: accepted.inputId,
        receptionId: "reception-1" as never,
        readAt: NOW,
      });
      assert.isDefined(first);
      // A restarted pass takes the input over; the earlier pass's late result is dropped.
      yield* ledger.beginReception({
        owner: "owner-a",
        inputId: accepted.inputId,
        receptionId: "reception-2" as never,
        readAt: "2026-10-12T00:00:09.000Z",
      });
      const decision = { replyText: "On it.", action: { type: "report_only" as const } };
      const late = yield* ledger.completeReception({
        owner: "owner-a",
        inputId: accepted.inputId,
        receptionId: "reception-1" as never,
        replyText: "On it.",
        decision,
        deliveries: [],
        now: NOW,
      });
      assert.isFalse(late);
      const current = yield* ledger.completeReception({
        owner: "owner-a",
        inputId: accepted.inputId,
        receptionId: "reception-2" as never,
        replyText: "On it.",
        decision,
        deliveries: [],
        now: NOW,
      });
      assert.isTrue(current);
      const stored = yield* ledger.getInput(accepted.inputId);
      assert.strictEqual(stored?.snapshot.state, "replied");
      // The first read time stays: it is when reception first started reading.
      assert.strictEqual(stored?.snapshot.readAt, NOW);
      assert.deepStrictEqual(stored?.decision, decision);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("ChannelLedger ownership", () => {
  it.effect("keeps workers in one process and fences a process that lost ownership", () =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.isTrue(yield* claimOwner("a", NOW, "2026-10-11T23:59:30.000Z"));
      // A fresh heartbeat keeps the row from another process.
      assert.isFalse(
        yield* claimOwner("b", "2026-10-12T00:00:10.000Z", "2026-10-11T23:59:40.000Z"),
      );
      // Once the heartbeat is stale, the other process takes over.
      assert.isTrue(yield* claimOwner("b", "2026-10-12T00:01:00.000Z", "2026-10-12T00:00:30.000Z"));
      const accepted = yield* accept();
      const lost = yield* Effect.flip(
        ledger.beginReception({
          owner: "a",
          inputId: accepted.inputId,
          receptionId: "reception-1" as never,
          readAt: NOW,
        }),
      );
      assert.strictEqual(lost.reason, "ownership_lost");
      assert.isDefined(
        yield* ledger.beginReception({
          owner: "b",
          inputId: accepted.inputId,
          receptionId: "reception-1" as never,
          readAt: NOW,
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("ChannelLedger tasks", () => {
  it.effect("applies events with an expected version and rejects stale writers", () =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* claimOwner("a", NOW, "2026-10-11T23:59:30.000Z");
      const accepted = yield* accept();
      yield* ledger.beginReception({
        owner: "a",
        inputId: accepted.inputId,
        receptionId: "r" as never,
        readAt: NOW,
      });
      const created = newTask(accepted.inputId, accepted.conversationId, accepted.bindingId);
      yield* ledger.completeReception({
        owner: "a",
        inputId: accepted.inputId,
        receptionId: "r" as never,
        replyText: "Starting.",
        decision: {
          replyText: "Starting.",
          action: {
            type: "create_task",
            title: "Re-verify the call",
            instruction: "Run it again.",
          },
        },
        createdTask: created,
        deliveries: [],
        now: NOW,
      });
      const target = {
        environmentId: "env-1",
        projectId: "project-1",
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      };
      const claim = decodeEvent({
        eventId: taskEventIdFor(created.task.taskId, 2),
        sequence: 0,
        taskId: created.task.taskId,
        taskVersion: 2,
        occurredAt: NOW,
        actor: "system",
        type: "task.dispatch.claimed",
        payload: { generation: 1, target, leaseExpiresAt: NOW },
      });
      const next = applyChannelTaskEvent(created.task, claim);
      assert.isTrue(next.ok);
      if (!next.ok) return;
      yield* ledger.applyTaskEvent({
        owner: "a",
        write: { next: next.task, expectedVersion: 1, event: claim },
        deliveries: [],
      });
      const stale = yield* Effect.flip(
        ledger.applyTaskEvent({
          owner: "a",
          write: {
            next: next.task,
            expectedVersion: 1,
            event: { ...claim, eventId: "other" as never },
          },
          deliveries: [],
        }),
      );
      assert.strictEqual(stale.reason, "version_conflict");
      const stored = yield* ledger.getTask(created.task.taskId);
      assert.strictEqual(stored?.task.status, "dispatching");
      const page = yield* ledger.listTasks({ ownerId: "owner", limit: 10 });
      assert.deepStrictEqual(
        page.tasks.map((task) => task.taskId),
        [created.task.taskId],
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("ChannelLedger outbox", () => {
  const delivery = (causeKey: string, destination: unknown, taskId?: string) => ({
    deliveryId: deliveryIdFor(causeKey),
    causeKey,
    ...(taskId === undefined ? {} : { taskId: taskId as never }),
    message: decodeOutbound({
      deliveryId: deliveryIdFor(causeKey),
      destination,
      kind: "receipt",
      text: "On it.",
    }),
  });
  const slackDestination = slackMessage().replyAddress;
  const goatDestination = { kind: "goat", environmentId: "env-1", threadId: "bot" };

  it.effect("delivers each cause once and settles in-flight deliveries after a restart", () =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* claimOwner("a", NOW, "2026-10-11T23:59:30.000Z");
      yield* ledger.enqueueDeliveries(
        [delivery("slack-receipt", slackDestination), delivery("goat-receipt", goatDestination)],
        NOW,
      );
      // Re-committing the same cause adds nothing.
      yield* ledger.enqueueDeliveries([delivery("slack-receipt", slackDestination)], NOW);
      const claimed = yield* ledger.claimDueDeliveries({ owner: "a", now: NOW, limit: 10 });
      assert.strictEqual(claimed.length, 2);
      yield* ledger.settleInterruptedDeliveries({ owner: "a", now: NOW });
      // An external send may have happened, so it is not repeated; the bot record is idempotent.
      assert.strictEqual(
        yield* ledger.getDeliveryState(deliveryIdFor("slack-receipt")),
        "ambiguous",
      );
      assert.strictEqual(yield* ledger.getDeliveryState(deliveryIdFor("goat-receipt")), "pending");
      const retried = yield* ledger.claimDueDeliveries({ owner: "a", now: NOW, limit: 10 });
      assert.deepStrictEqual(
        retried.map((row) => row.deliveryId),
        [deliveryIdFor("goat-receipt")],
      );
      yield* ledger.recordDelivery({
        owner: "a",
        deliveryId: deliveryIdFor("goat-receipt"),
        outcome: { type: "retry", at: "2026-10-12T00:00:30.000Z", errorCode: "rate_limited" },
        now: NOW,
      });
      assert.deepStrictEqual(
        yield* ledger.claimDueDeliveries({ owner: "a", now: NOW, limit: 10 }),
        [],
      );
      assert.strictEqual(
        (yield* ledger.claimDueDeliveries({
          owner: "a",
          now: "2026-10-12T00:00:30.000Z",
          limit: 10,
        })).length,
        1,
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "holds a task's later delivery until its earlier one to the same destination kind is done",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* claimOwner("a", NOW, "2026-10-11T23:59:30.000Z");
        const claim = (now = NOW) =>
          ledger
            .claimDueDeliveries({ owner: "a", now, limit: 10 })
            .pipe(Effect.map((rows) => rows.map((row) => row.deliveryId)));
        // Same timestamp: insertion order decides, not the hashed delivery id.
        yield* ledger.enqueueDeliveries(
          [
            delivery("receipt", slackDestination, "task-1"),
            delivery("result", slackDestination, "task-1"),
            delivery("bot-copy", goatDestination, "task-1"),
          ],
          NOW,
        );
        assert.deepStrictEqual(yield* claim(), [
          deliveryIdFor("receipt"),
          deliveryIdFor("bot-copy"),
        ]);
        // A receipt waiting out a rate limit keeps the result behind it.
        yield* ledger.recordDelivery({
          owner: "a",
          deliveryId: deliveryIdFor("receipt"),
          outcome: { type: "retry", at: "2026-10-12T00:00:30.000Z", errorCode: "rate_limited" },
          now: NOW,
        });
        assert.deepStrictEqual(yield* claim("2026-10-12T00:00:10.000Z"), []);
        assert.deepStrictEqual(yield* claim("2026-10-12T00:00:30.000Z"), [
          deliveryIdFor("receipt"),
        ]);
        yield* ledger.recordDelivery({
          owner: "a",
          deliveryId: deliveryIdFor("receipt"),
          outcome: { type: "delivered" },
          now: "2026-10-12T00:00:30.000Z",
        });
        assert.deepStrictEqual(yield* claim("2026-10-12T00:00:30.000Z"), [deliveryIdFor("result")]);
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe("ChannelLedger identity links", () => {
  it.effect("consumes a link code once, before it expires", () =>
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const codeHash = linkCodeHashFor("slack-1", "483920");
      yield* ledger.createIdentityLink({
        codeHash,
        connectionId: "slack-1",
        identity: {
          ownerId: "owner",
          principalId: "owner",
          displayName: "Jun",
          runtimeModeCeiling: "approval-required",
          grantedScopes: ["orchestration:read"],
        },
        expiresAt: "2026-10-12T00:10:00.000Z",
        now: NOW,
      });
      const notice = {
        deliveryId: deliveryIdFor("link:ok"),
        causeKey: "link:ok",
        message: decodeOutbound({
          deliveryId: deliveryIdFor("link:ok"),
          destination: slackMessage().replyAddress,
          kind: "receipt",
          text: "Linked.",
        }),
      };
      const failureNotice = {
        ...notice,
        causeKey: "link:bad",
        deliveryId: deliveryIdFor("link:bad"),
      };
      const consume = (now: string) =>
        ledger.consumeIdentityLink({
          codeHash,
          connectionId: "slack-1",
          externalActorId: "U1",
          now,
          notice,
          failureNotice,
        });
      assert.strictEqual((yield* consume(NOW)).type, "linked");
      assert.strictEqual((yield* consume(NOW)).type, "invalid");
      const identity = yield* ledger.findIdentity({
        connectionId: "slack-1",
        externalActorId: "U1",
      });
      assert.strictEqual(identity?.runtimeModeCeiling, "approval-required");
      assert.isTrue(
        yield* ledger.unlinkIdentity({ connectionId: "slack-1", externalActorId: "U1" }),
      );
      assert.isUndefined(
        yield* ledger.findIdentity({ connectionId: "slack-1", externalActorId: "U1" }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("ChannelLedger answer project choices", () => {
  it.effect(
    "persists resolutions once, fences writes, and keeps unresolved answers as barriers",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* claimOwner("a", NOW, "2026-10-11T23:59:30.000Z");
        const accepted = yield* accept();
        yield* ledger.beginReception({
          owner: "a",
          inputId: accepted.inputId,
          receptionId: "r" as never,
          readAt: NOW,
        });
        const created = newTask(accepted.inputId, accepted.conversationId, accepted.bindingId);
        yield* ledger.completeReception({
          owner: "a",
          inputId: accepted.inputId,
          receptionId: "r" as never,
          replyText: "Starting.",
          decision: { replyText: "Starting.", action: { type: "report_only" } },
          createdTask: created,
          deliveries: [],
          now: NOW,
        });
        const answer = (text: string, choice?: ChannelAnswerProjectChoice) =>
          Effect.gen(function* () {
            const stored = (yield* ledger.getTask(created.task.taskId))!;
            yield* commitTransition(ledger, stored, {
              type: "task.question.opened",
              payload: {
                question: { questionId: "q" as never, text: "Which project?", askedAt: NOW },
              },
            });
            const waiting = (yield* ledger.getTask(created.task.taskId))!;
            yield* commitTransition(ledger, waiting, {
              type: "task.question.answered",
              payload: { questionId: "q" as never, answer: text },
            });
            const event = (yield* ledger.recentAnswers(created.task.taskId, 1))[0]!;
            assert.isUndefined(event.payload.projectChoice);
            if (choice !== undefined)
              yield* ledger.recordAnswerProjectChoice({
                owner: "a",
                eventId: event.eventId,
                choice,
              });
            return event;
          });
        const remote = {
          type: "remote",
          host: "studio",
          projectId: ProjectId.make("remote-p"),
        } as const;
        const first = yield* answer("P", remote);
        yield* ledger.recordAnswerProjectChoice({
          owner: "a",
          eventId: first.eventId,
          choice: { type: "none" },
        });
        assert.deepStrictEqual(
          (yield* ledger.recentAnswers(created.task.taskId, 1))[0]?.payload.projectChoice,
          remote,
        );
        yield* answer("try again", { type: "none" });
        yield* answer("try again", { type: "none" });
        assert.deepStrictEqual(yield* ledger.rememberedProjectChoice(created.task.taskId), remote);
        const unresolved = yield* answer("unknown while offline");
        yield* answer("try again", { type: "none" });
        assert.isUndefined(yield* ledger.rememberedProjectChoice(created.task.taskId));
        const lost = yield* Effect.flip(
          ledger.recordAnswerProjectChoice({
            owner: "other",
            eventId: unresolved.eventId,
            choice: remote,
          }),
        );
        assert.strictEqual(lost.reason, "ownership_lost");
        yield* ledger.recordAnswerProjectChoice({
          owner: "a",
          eventId: unresolved.eventId,
          choice: { type: "local", projectId: ProjectId.make("local-p") },
        });
        assert.deepStrictEqual(yield* ledger.rememberedProjectChoice(created.task.taskId), {
          type: "local",
          projectId: ProjectId.make("local-p"),
        });
        const stored = (yield* ledger.getTask(created.task.taskId))!;
        yield* commitTransition(ledger, stored, {
          type: "task.cancelled",
          payload: { reason: "Restart" },
        });
        yield* commitTransition(ledger, (yield* ledger.getTask(created.task.taskId))!, {
          type: "task.retry.requested",
          payload: { generation: 2 },
        });
        assert.deepStrictEqual(yield* ledger.recentAnswers(created.task.taskId, 1), []);
        assert.isUndefined(yield* ledger.rememberedProjectChoice(created.task.taskId));
      }).pipe(Effect.provide(TestLayer)),
  );
});
