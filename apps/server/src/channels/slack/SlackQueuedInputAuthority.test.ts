import { assert, describe, it } from "@effect/vitest";
import { ChannelQuestionId, ProviderDriverKind, ProviderTurnId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { nextTurnSelectionHarness } from "../../orchestration-v2/testkit/SteeringHarness.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ChannelIdentityService from "../ChannelIdentityService.ts";
import * as ChannelLedger from "../ChannelLedger.ts";
import * as ChannelRuntime from "../ChannelRuntime.ts";
import * as SlackChannelSettings from "../SlackChannelSettings.ts";
import { answerForwardIdsFor, inputIdFor, turnSteerIdsFor } from "../channelIds.ts";
import { commitTransition } from "../channelTaskWrites.ts";
import {
  defaultScript,
  modelSelection,
  owner,
  ownerId,
  setupBot,
} from "../testkit/ChannelHarness.ts";
import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import { emit, ROOT_TS, slackScenario, tasks } from "./slackChannelScenarioHarness.ts";
import { channelMention, directMessage } from "./slackChannelTestSupport.ts";

describe("Provider start for queued Slack inputs", () => {
  it.effect.each([
    { kind: "follow-up", revoked: "sender", provenance: "recorded" },
    { kind: "follow-up", revoked: "requester", provenance: "recorded" },
    { kind: "follow-up", revoked: "workspace access", provenance: "recorded" },
    { kind: "answer", revoked: "sender", provenance: "recorded" },
    { kind: "follow-up", revoked: "sender", provenance: "legacy" },
  ] as const)(
    "refuses a queued Slack $kind after revoking $revoked with $provenance provenance",
    ({ kind, revoked, provenance }) =>
      Effect.gen(function* () {
        const provider = yield* nextTurnSelectionHarness(
          "slack-queued-followup",
          false,
          Effect.void,
          false,
          undefined,
          false,
        );
        const { sdk, harness, layer } = slackScenario({
          botWorkspace: true,
          realWorkerLaunch: true,
          workerAdapter: provider.adapter,
          botWorkspaceRoot: provider.cwd,
          settingsLayer: ServerSettings.layerTest({
            goatBotModelSelection: modelSelection,
            providerInstances: {
              [modelSelection.instanceId]: {
                driver: ProviderDriverKind.make("codex"),
                config: {},
                enabled: true,
              },
            },
          }).pipe(Layer.orDie),
        });
        yield* Effect.gen(function* () {
          yield* setupBot;
          const guest = revoked === "workspace access";
          const settings = yield* SlackChannelSettings.SlackChannelSettings;
          const connection = yield* settings.configure(
            {
              enabled: true,
              userAccess: guest ? "workspace" : "linked",
              appToken: "xapp-1-test",
              botToken: "xoxb-test",
            },
            owner,
          );
          const runtime = yield* ChannelRuntime.ChannelRuntime;
          yield* (yield* SlackChannelRuntime.SlackChannelRuntime).streamStatus.pipe(
            Stream.filter((status) => status.status === "connected"),
            Stream.runHead,
          );
          if (!guest) {
            const identities = yield* ChannelIdentityService.ChannelIdentityService;
            for (const user of ["U0ALICE", "U0BOB"]) {
              const { code } = yield* identities.createLink(
                { connectionId: connection.connectionId, runtimeModeCeiling: "auto-accept-edits" },
                { ...owner, principalId: user },
              );
              yield* emit(sdk, directMessage({ user, text: "link " + code }), "EvLink" + user);
            }
          }
          yield* emit(sdk, channelMention({ text: "<@U0BOT> Check the build" }), "EvFollowupStart");
          yield* runtime.drain;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* worker.drain();
          const [first] = provider.started;
          assert(first !== undefined);
          const [task] = (yield* tasks).tasks;
          assert(task?.worker !== undefined);
          const { threadId } = task.worker;
          yield* TestClock.adjust("55 seconds");
          yield* runtime.expireOverdue;
          yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
            goatBotSessionRouting: "reception",
          });
          const ledger = yield* ChannelLedger.ChannelLedger;
          const questionId = ChannelQuestionId.make("question:queued-slack-answer");
          if (kind === "answer") {
            const stored = yield* ledger.getTask(task.taskId);
            assert(stored !== undefined);
            yield* commitTransition(
              ledger,
              stored,
              {
                type: "task.question.opened",
                payload: { question: { questionId, text: "Which logs?", askedAt: task.updatedAt } },
              },
              { owner: runtime.ownerToken },
            );
          }
          harness.script.current = (input) =>
            input.inputText === "Also check the logs"
              ? Effect.succeed({
                  replyText: "On it.",
                  action:
                    kind === "answer"
                      ? {
                          type: "answer_question",
                          taskId: task.taskId,
                          questionId,
                          answer: input.inputText,
                        }
                      : { type: "follow_up", taskId: task.taskId },
                })
              : defaultScript(input);
          const followupEventId = "EvForwardQueued";
          yield* emit(
            sdk,
            channelMention({
              user: guest ? "U0ALICE" : "U0BOB",
              text: "<@U0BOT> Also check the logs",
              ts: "1760000000.000101",
              thread_ts: ROOT_TS,
            }),
            followupEventId,
          );
          yield* runtime.drain;
          const followupInputId = inputIdFor({
            ownerId,
            kind: "slack",
            connectionId: connection.connectionId,
            idempotencyKey: "T0TEAM:" + followupEventId,
          });
          const messageIds = [
            turnSteerIdsFor(followupInputId, "first").messageId,
            turnSteerIdsFor(followupInputId, "queued").messageId,
          ];
          if (kind === "answer") {
            const [answer] = yield* ledger.recentAnswers(task.taskId, 1);
            assert(answer !== undefined);
            messageIds.push(answerForwardIdsFor(answer.eventId).messageId);
          }
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
          const queued = runs.find((run) => messageIds.some((id) => id === run.userMessageId));
          assert(queued !== undefined);
          assert.strictEqual(queued.status, "queued");
          if (provenance === "legacy") {
            const sql = yield* SqlClient.SqlClient;
            const removed = yield* sql`DELETE FROM channel_runtime_state
              WHERE key = ${"channel-session-forward:" + threadId + ":" + queued.userMessageId}
              RETURNING key`;
            assert.lengthOf(removed, 1);
          }
          if (guest) {
            yield* settings.configure(
              {
                connectionId: connection.connectionId,
                enabled: true,
                userAccess: "linked",
              },
              owner,
            );
          } else {
            assert.isTrue(
              yield* ledger.unlinkIdentity({
                connectionId: connection.connectionId,
                externalActorId: revoked === "sender" ? "U0BOB" : "U0ALICE",
              }),
            );
          }
          const sink = yield* EventSink.EventSinkV2;
          const afterSequence = yield* sink.latestSequence({ threadId });
          yield* Queue.offer(provider.events, {
            type: "turn.terminal",
            driver: ProviderDriverKind.make("codex"),
            providerThreadId: first.providerThread.id,
            providerTurnId: ProviderTurnId.make(`provider-turn:${first.attemptId}`),
            runOrdinal: first.runOrdinal,
            status: "interrupted",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* sink.stream({ threadId, afterSequence, eventType: "run.updated" }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.payload.id === queued.id &&
                event.payload.status === "starting",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* worker.drain();
          assert.lengthOf(provider.started, 1);
          const records = yield* orchestrator.getThreadRecords(threadId, ["runs", "turnItems"], {
            turnItemRunIds: [queued.id],
          });
          assert.strictEqual(records.runs.find((run) => run.id === queued.id)?.status, "failed");
          assert.isTrue(
            records.turnItems.some(
              (item) => item.type === "error" && item.failure.code === "permission_changed",
            ),
          );
          yield* runtime.drain;
          assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.status, "failed");
        }).pipe(Effect.provide(layer));
      }),
  );
});
