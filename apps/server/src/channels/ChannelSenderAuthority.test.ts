import { launchBrief } from "./testkit/providerBrief.ts";
import { assert, describe, it } from "@effect/vitest";
import type { AuthEnvironmentScope, ChannelReceptionInput, ChannelTaskId } from "@goat/contracts";
import { ChannelQuestionId, EventId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SessionStore from "../auth/SessionStore.ts";
import { layerSessionStore } from "../auth/SessionEnd.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderTurnStart from "../orchestration-v2/ProviderTurnStartService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { nextTurnSelectionHarness } from "../orchestration-v2/testkit/SteeringHarness.ts";
import { preparationSettled } from "../orchestration-v2/testkit/preparationSettled.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { appendChannelBotNote, channelBotFilesFor } from "./channelBotNotes.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { taskIdFor, toolSteerIdsFor, turnSteerIdsFor } from "./channelIds.ts";
import { senderOf } from "./channelSenderAuthority.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { sessionHarness } from "./ChannelBotSession.testkit.ts";
import {
  defaultScript,
  goatInput,
  memoryRpcContext,
  makeHarness,
  owner,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const ROOT = "1760000000.000900";
const transport = {
  ...slackContext,
  grantedScopes: [...slackContext.grantedScopes, "memory:read", "memory:write"],
} satisfies typeof slackContext;

/** Links a Slack user with these extra scopes; the creator holds memory so the link keeps them. */
const link = (user: string, principalId: string, scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const { code } = yield* identities.createLink(
      {
        connectionId: "slack-1",
        runtimeModeCeiling: "auto-accept-edits",
        grantedScopes: ["orchestration:read", "orchestration:operate", ...scopes],
      },
      {
        ...owner,
        principalId,
        displayName: principalId,
        grantedScopes: [...owner.grantedScopes, "memory:read", "memory:write"],
      },
    );
    yield* (yield* ChannelGateway.ChannelGateway).linkIdentity(
      {
        connectionId: "slack-1",
        externalActorId: user,
        code,
        idempotencyKey: "link-" + user,
        replyAddress: slackInput("", "unused").replyAddress,
      },
      slackContext,
    );
  });

const narrow = (user: string, scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`UPDATE channel_identities SET granted_scopes_json = ${JSON.stringify(scopes)} WHERE connection_id = 'slack-1' AND external_actor_id = ${user}`,
  );

/** One Slack message in the task's thread, read by reception; nothing is forwarded yet. */
const say = (user: string, text: string, key: string) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* runtime.drain;
    const ingested = yield* gateway.ingest(slackInput(text, key, ROOT, user), transport);
    yield* (yield* ChannelReceptionService.ChannelReceptionService).receive(
      ingested.inputId,
      runtime.ownerToken,
    );
    return ingested.inputId;
  });

const forwardAll = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
  for (const pending of yield* ledger.listPendingForwards(10))
    yield* dispatcher.forward(pending, runtime.ownerToken);
});

const start = (text: string, key: string) =>
  Effect.gen(function* () {
    const inputId = yield* say("U2", text, key);
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const taskId = taskIdFor(inputId, 0);
    yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(taskId, runtime.ownerToken);
    return (yield* (yield* ChannelLedger.ChannelLedger).getTask(taskId))!;
  });

const task = (taskId: ChannelTaskId) =>
  Effect.flatMap(ChannelLedger.ChannelLedger, (ledger) => ledger.getTask(taskId)).pipe(
    Effect.map((stored) => stored!.task),
  );

const notices = (taskId: ChannelTaskId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{
        readonly message_json: string;
      }>`SELECT message_json FROM channel_outbox WHERE task_id = ${taskId} AND cause_key LIKE 'sender-refused:%'`,
  );

/** "do:" starts work on a local worker; "more:<task> text" follows it up; "answer:<task> <question> text" answers. */
const localScript = (input: ChannelReceptionInput) => {
  const text = input.inputText ?? "";
  if (input.mode === "input" && text.startsWith("more:"))
    return Effect.succeed({
      replyText: "Passing that on.",
      action: { type: "follow_up" as const, taskId: text.slice(5).split(" ")[0] as ChannelTaskId },
    });
  if (input.mode === "input" && text.startsWith("answer:")) {
    const [taskId, questionId, ...answer] = text.slice(7).split(" ");
    return Effect.succeed({
      replyText: "Passing that on.",
      action: {
        type: "answer_question" as const,
        taskId: taskId as ChannelTaskId,
        questionId: questionId as never,
        answer: answer.join(" "),
      },
    });
  }
  return defaultScript(input);
};

const harnesses = {
  session: () => ({ harness: sessionHarness(), opening: "look: check the disk" }),
  local: () => {
    const harness = makeHarness();
    harness.script.current = localScript;
    return { harness, opening: "do: check the disk" };
  },
};

it.effect("a Slack follow-up after revocation cannot reuse a warm session holding notes", () => {
  const { harness, opening } = harnesses.session();
  return Effect.gen(function* () {
    yield* setupBot;
    const files = channelBotFilesFor(yield* Path.Path, (yield* ServerConfig.ServerConfig).stateDir);
    const fs = yield* FileSystem.FileSystem;
    const note = "Follow the Juniper release checklist.";
    yield* appendChannelBotNote(fs, files, note, "2026-11-21T00:00:00Z", "fixture");
    yield* link("U2", "teammate", ["memory:read"]);
    const stored = yield* start(opening, "start-with-notes");
    assert.include(yield* launchBrief(harness.world.launches[0]), note);
    yield* say("U2", "more:" + stored.task.taskId + " check again", "follow");
    yield* narrow("U2", ["orchestration:read", "orchestration:operate"]);
    yield* forwardAll;
    assert.isFalse(harness.world.sends.some((send) => send.text.includes("check again")));
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "checks the same principal's follow-up session before sending into notes-bearing work",
  () => {
    const { harness, opening } = harnesses.session();
    return Effect.gen(function* () {
      yield* setupBot;
      const files = channelBotFilesFor(
        yield* Path.Path,
        (yield* ServerConfig.ServerConfig).stateDir,
      );
      yield* appendChannelBotNote(
        yield* FileSystem.FileSystem,
        files,
        "Use Juniper for staging.",
        "2026-11-21T00:00:00Z",
        "fixture",
      );
      const sessions = yield* SessionStore.SessionStore;
      const issue = sessions.issue({
        subject: memoryRpcContext.principalId,
        scopes: memoryRpcContext.grantedScopes,
      });
      const opener = yield* issue;
      const follower = yield* issue;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* runtime.drain;
      const first = yield* gateway.ingest(goatInput(opening, "app-opener"), {
        ...memoryRpcContext,
        authSessionId: opener.sessionId,
      });
      yield* reception.receive(first.inputId, runtime.ownerToken);
      const taskId = taskIdFor(first.inputId, 0);
      yield* dispatcher.dispatch(taskId, runtime.ownerToken);
      assert.isDefined((yield* ledger.latestTaskBrief(taskId))?.context.notesPath);
      const text = "check the staging report again";
      const next = yield* gateway.ingest(goatInput("more:" + taskId + " " + text, "app-follower"), {
        ...memoryRpcContext,
        authSessionId: follower.sessionId,
      });
      yield* reception.receive(next.inputId, runtime.ownerToken);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
      yield* sessions.revoke(follower.sessionId);
      yield* forwardAll;
      assert.isFalse(harness.world.sends.some((send) => send.text.includes(text)));
      assert.lengthOf(yield* notices(taskId), 1);
    }).pipe(
      Effect.provide(
        harness.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(SqlitePersistence.layerMemory, layerSessionStore)),
        ),
      ),
    );
  },
);

describe.each(["session", "local"] as const)("a %s worker's delivery from someone else", (kind) => {
  it.effect("drops a follow-up whose sender lost access after it was accepted", () => {
    const { harness, opening } = harnesses[kind]();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* link("U2", "teammate", ["memory:read"]);
      yield* link("U1", "colleague", ["memory:read"]);
      const stored = yield* start(opening, "start");
      assert.strictEqual(stored.task.status, "running");
      yield* say("U1", "more:" + stored.task.taskId + " colleague note", "follow");
      yield* narrow("U1", ["orchestration:read", "orchestration:operate"]);
      yield* forwardAll;
      assert.isFalse(harness.world.sends.some((send) => send.text.includes("colleague note")));
      assert.lengthOf(yield* notices(stored.task.taskId), 1);
      assert.strictEqual((yield* task(stored.task.taskId)).status, "running");
      assert.lengthOf(yield* (yield* ChannelLedger.ChannelLedger).listPendingForwards(10), 0);
      // Processing again posts nothing more.
      yield* forwardAll;
      assert.lengthOf(yield* notices(stored.task.taskId), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "records a refusal and its notice together, so a crash then restored access delivers",
    () => {
      const { harness, opening } = harnesses[kind]();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* link("U2", "teammate", ["memory:read"]);
        yield* link("U1", "colleague", ["memory:read"]);
        const stored = yield* start(opening, "start");
        yield* say("U1", "more:" + stored.task.taskId + " colleague note", "follow");
        yield* narrow("U1", ["orchestration:read", "orchestration:operate"]);
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const complete = ledger.completeForward;
        Object.assign(ledger, {
          completeForward: () => Effect.die("crash before the refusal commits"),
        });
        const [pending] = yield* ledger.listPendingForwards(10);
        yield* (yield* ChannelDispatcher.ChannelDispatcher)
          .forward(pending!, runtime.ownerToken)
          .pipe(Effect.exit);
        Object.assign(ledger, { completeForward: complete });
        assert.lengthOf(yield* notices(stored.task.taskId), 0);
        assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
        yield* narrow("U1", ["orchestration:read", "orchestration:operate", "memory:read"]);
        yield* forwardAll;
        assert.isTrue(harness.world.sends.some((send) => send.text.includes("colleague note")));
        assert.lengthOf(yield* notices(stored.task.taskId), 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("asks again when an answer's sender lost access after it was accepted", () => {
    const { harness, opening } = harnesses[kind]();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* link("U2", "teammate", ["memory:read"]);
      yield* link("U1", "colleague", ["memory:read"]);
      const stored = yield* start(opening, "start");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const questionId = ChannelQuestionId.make("question:disk");
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(stored.task.taskId))!,
        {
          type: "task.question.opened",
          payload: {
            question: { questionId, text: "Which disk?", askedAt: "2026-10-12T00:00:00.000Z" },
          },
        },
        { owner: runtime.ownerToken },
      );
      yield* say("U1", "answer:" + stored.task.taskId + " " + questionId + " sda", "answer");
      assert.lengthOf((yield* task(stored.task.taskId)).openQuestions, 0);
      yield* narrow("U1", ["orchestration:read", "orchestration:operate"]);
      yield* forwardAll;
      assert.isFalse(harness.world.sends.some((send) => send.text.includes("sda")));
      const asked = (yield* task(stored.task.taskId)).openQuestions;
      assert.lengthOf(asked, 1);
      assert.include(asked[0]!.text, "colleague");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("delivers the requester's follow-up after memory revocation in notes-free work", () => {
    const { harness, opening } = harnesses[kind]();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* link("U2", "teammate", []);
      const stored = yield* start(opening, "start");
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.isUndefined((yield* ledger.latestTaskBrief(stored.task.taskId))?.context.notesPath);
      yield* narrow("U2", ["orchestration:read", "orchestration:operate", "memory:read"]);
      yield* say("U2", "more:" + stored.task.taskId + " own note", "own");
      yield* narrow("U2", ["orchestration:read", "orchestration:operate"]);
      yield* forwardAll;
      assert.isTrue(harness.world.sends.some((send) => send.text.includes("own note")));
      assert.lengthOf(yield* notices(stored.task.taskId), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "delivers a still-allowed colleague's follow-up and an event stored without a sender",
    () => {
      const { harness, opening } = harnesses[kind]();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* link("U2", "teammate", ["memory:read"]);
        yield* link("U1", "colleague", ["memory:read"]);
        const stored = yield* start(opening, "start");
        yield* say("U1", "more:" + stored.task.taskId + " allowed note", "allowed");
        yield* forwardAll;
        assert.isTrue(harness.world.sends.some((send) => send.text.includes("allowed note")));
        // A follow-up recorded before senders were stored, as a pending forward at upgrade.
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const inputId = yield* say("U2", "hello", "old-input");
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(stored.task.taskId))!,
          {
            type: "task.followup.received",
            payload: {
              inputId,
              text: "old note",
              from: "colleague",
              generation: stored.task.generation,
            },
          },
          {
            owner: runtime.ownerToken,
            actor: "user",
            forward: true,
            pendingAnswerMessageId: turnSteerIdsFor(inputId).messageId,
          },
        );
        yield* narrow("U1", ["orchestration:read", "orchestration:operate"]);
        yield* forwardAll;
        assert.isTrue(harness.world.sends.some((send) => send.text.includes("old note")));
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("a local worker's follow-up", () => {
  it.effect.each([
    "before forward",
    "requester before forward",
    "before steer dispatch",
    "before provider steer",
    "before queued start",
    "agent before queued start",
    "queued before sender binding existed",
    "allowed",
  ] as const)("checks live authority for notes-bearing worker follow-ups (%s)", (phase) =>
    Effect.gen(function* () {
      const canSteer =
        phase.endsWith("before forward") ||
        phase === "before steer dispatch" ||
        phase === "before provider steer";
      const provider = yield* nextTurnSelectionHarness(
        "worker-followup-notes",
        false,
        Effect.void,
        false,
        undefined,
        canSteer,
      );
      const harness = makeHarness({
        realWorkerLaunch: true,
        workspaceRoot: import.meta.dirname,
        workerAdapter: provider.adapter,
      });
      harness.script.current = localScript;
      yield* Effect.gen(function* () {
        yield* setupBot;
        const note = "Use Juniper for staging.";
        const files = channelBotFilesFor(
          yield* Path.Path,
          (yield* ServerConfig.ServerConfig).stateDir,
        );
        yield* appendChannelBotNote(
          yield* FileSystem.FileSystem,
          files,
          note,
          "2026-11-21T00:00:00Z",
          "fixture",
        );
        const sessions = yield* SessionStore.SessionStore;
        const issue = sessions.issue({
          subject: memoryRpcContext.principalId,
          scopes: memoryRpcContext.grantedScopes,
        });
        const opener = yield* issue;
        const sender = yield* issue;
        const revoke = sessions.revoke(sender.sessionId);
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reception = yield* ChannelReceptionService.ChannelReceptionService;
        const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* runtime.drain;
        const first = yield* gateway.ingest(goatInput("do: check the deploy", "worker-opener"), {
          ...memoryRpcContext,
          authSessionId: opener.sessionId,
        });
        yield* reception.receive(first.inputId, runtime.ownerToken);
        const taskId = taskIdFor(first.inputId, 0);
        yield* dispatcher.dispatch(taskId, runtime.ownerToken);
        const worker = (yield* task(taskId)).worker;
        if (worker?.runId === undefined) return yield* Effect.die("The worker did not launch");
        const { threadId, runId } = worker;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const read = threads.getThreadRecords(threadId, ["messages", "runs"]);
        const prepared = yield* preparationSettled(threadId);
        assert.strictEqual(prepared.runs.find((run) => run.id === runId)?.status, "starting");
        const starts = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
        yield* starts.start({ threadId, runId });
        assert.include(provider.started[0]?.message.text ?? "", note);
        if (phase === "before provider steer") {
          yield* threads.streamStoredEventsFrom({ threadId }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.runHead,
          );
        }

        const next = yield* gateway.ingest(
          goatInput("more:" + taskId + " check again", "worker-follower"),
          {
            ...memoryRpcContext,
            authSessionId: sender.sessionId,
          },
        );
        if (phase === "queued before sender binding existed") {
          const target = (yield* task(taskId)).target;
          if (target === undefined) return yield* Effect.die("No worker target");
          yield* threads.sendToThread({
            ...turnSteerIdsFor(next.inputId, "queued"),
            projectId: target.projectId,
            threadId,
            text: "Follow-up queued by an older server",
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "server",
          });
        } else {
          if (phase === "agent before queued start") {
            const stored = yield* ledger.getTask(taskId);
            const source = yield* ledger.getInput(next.inputId);
            if (stored === undefined || source?.requester === undefined)
              return yield* Effect.die("Missing worker task or sender input");
            const forwardKey = "agent-worker-followup";
            yield* commitTransition(
              ledger,
              stored,
              {
                type: "task.followup.received",
                payload: {
                  inputId: stored.task.originInputId,
                  forwardKey,
                  text: "check again",
                  from: source.requester.displayName,
                  generation: stored.task.generation,
                  sender: senderOf(source.requester, source.message.connectionId, next.inputId),
                },
              },
              {
                actor: "agent",
                owner: runtime.ownerToken,
                forward: true,
                pendingAnswerMessageId: toolSteerIdsFor(forwardKey).messageId,
              },
            );
          } else {
            yield* reception.receive(next.inputId, runtime.ownerToken);
          }
          const [pending] = yield* ledger.listPendingForwards(10);
          assert.strictEqual(pending?.event.type, "task.followup.received");
          if (pending === undefined) return yield* Effect.die("No follow-up was recorded");
          if (phase === "before forward") yield* revoke;
          if (phase === "requester before forward") yield* sessions.revoke(opener.sessionId);
          if (phase === "before steer dispatch") {
            const send = threads.sendToThread;
            Object.assign(threads, {
              sendToThread: (input: Parameters<typeof send>[0]) =>
                revoke.pipe(Effect.andThen(send(input))),
            });
          }
          yield* dispatcher.forward(pending, runtime.ownerToken);
        }
        const forwarded = yield* read;
        if (phase === "before provider steer") {
          const ids = turnSteerIdsFor(next.inputId);
          assert.strictEqual(
            forwarded.messages.find((message) => message.id === ids.messageId)?.runId,
            runId,
          );
          assert.lengthOf(forwarded.runs, 1);
          yield* revoke;
          const effects = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* effects.drain();
          assert.deepStrictEqual(provider.steered, []);
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          const requests = yield* outbox.listByCommandId(ids.commandId);
          assert.strictEqual(
            requests.find((request) => request.request.type === "provider-turn.steer")?.status,
            "failed",
          );
          return;
        }
        if (canSteer) {
          assert.isFalse(
            forwarded.messages.some((message) => message.text.includes("check again")),
          );
          if (phase === "requester before forward") {
            assert.include(
              (yield* task(taskId)).openQuestions[0]?.text ?? "",
              "permission changed",
            );
          } else {
            assert.lengthOf(yield* notices(taskId), 1);
          }
          return;
        }
        const queued = forwarded.runs.find((run) => run.id !== runId);
        const active = forwarded.runs.find((run) => run.id === runId);
        assert.strictEqual(queued?.status, "queued");
        if (queued === undefined || active?.status !== "running")
          return yield* Effect.die("Expected an active run and a queued follow-up");
        if (phase.endsWith("before queued start")) yield* revoke;
        const now = yield* DateTime.now;
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("event:worker-first-turn-settled"),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              providerInstanceId: active.providerInstanceId,
              payload: { ...active, status: "completed", completedAt: now },
            },
          ],
        });
        yield* (yield* Orchestrator.OrchestratorV2).resumeQueuedRuns;
        assert.strictEqual(
          (yield* read).runs.find((run) => run.id === queued.id)?.status,
          "starting",
        );
        yield* starts.start({ threadId, runId: queued.id });
        if (phase === "allowed") {
          assert.lengthOf(provider.started, 2);
          assert.include(provider.started[1]?.message.text ?? "", "check again");
          assert.notInclude(provider.started[1]?.message.text ?? "", note);
        } else {
          assert.lengthOf(provider.started, 1);
          assert.strictEqual(
            (yield* read).runs.find((run) => run.id === queued.id)?.status,
            "failed",
          );
        }
      }).pipe(
        Effect.provide(
          harness.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(SqlitePersistence.layerMemory, layerSessionStore)),
          ),
        ),
      );
    }),
  );

  it.effect("steers only the running run it checked, never whichever run is current", () => {
    const { harness, opening } = harnesses.local();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* link("U2", "teammate", ["memory:read"]);
      const stored = yield* start(opening, "start");
      const threadId = stored.task.worker!.threadId;
      const [run] = harness.world.runs.get(threadId)!;
      yield* say("U2", "more:" + stored.task.taskId + " pinned note", "pinned");
      yield* forwardAll;
      const send = harness.world.sends.find((entry) => entry.text.includes("pinned note"));
      assert.strictEqual(send?.mode, "steer");
      assert.strictEqual(send?.targetRunId, run!.id);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "queues instead of steering a run that holds more memory than the requester now has",
    () => {
      const { harness, opening } = harnesses.local();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* link("U2", "teammate", ["memory:read", "memory:write"]);
        const stored = yield* start(opening, "start");
        const threadId = stored.task.worker!.threadId;
        const [run] = harness.world.runs.get(threadId)!;
        harness.world.runs.set(threadId, [{ ...run!, memoryGrantCeiling: "read_write" }]);
        yield* narrow("U2", ["orchestration:read", "orchestration:operate", "memory:read"]);
        yield* say("U2", "more:" + stored.task.taskId + " lowered note", "lowered");
        yield* forwardAll;
        const send = harness.world.sends.find((entry) => entry.text.includes("lowered note"));
        assert.strictEqual(send?.mode, "queue");
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
