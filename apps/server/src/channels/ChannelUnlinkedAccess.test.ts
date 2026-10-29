import { assert, describe, it } from "@effect/vitest";
import { type ChannelTask, ChannelTaskEventId, type RuntimeMode } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLayers from "./ChannelLayers.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import {
  linkSlackUser,
  makeHarness,
  onlyTask,
  owner,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

/**
 * Slack people who never linked an account, on a connection that lets the whole workspace in.
 * The gateway admits them from the connection's context; every later check reads the
 * connection's settings again through SlackChannelSettings.unlinkedIdentity.
 */

const UNLINKED_CEILING: RuntimeMode = "approval-required";

/** Slack settings that admit unlinked people while `open.current` is true. */
const workspaceAccess = (open: { current: boolean }) =>
  Layer.effect(
    SlackChannelSettings.SlackChannelSettings,
    Effect.map(SlackChannelSettings.SlackChannelSettings, (unavailable) =>
      SlackChannelSettings.SlackChannelSettings.of({
        ...unavailable,
        unlinkedIdentity: (connectionId, externalActorId) =>
          Effect.succeed(
            open.current
              ? Option.some(
                  ChannelGateway.unlinkedIdentity(owner, {
                    connectionId,
                    externalActorId,
                    runtimeModeCeiling: UNLINKED_CEILING,
                  }),
                )
              : Option.none(),
          ),
      }),
    ),
  ).pipe(Layer.provide(SlackChannelSettings.layerUnavailable));

const scenario = () => {
  const open = { current: true };
  const harness = makeHarness({
    channelsLayer: ChannelLayers.makeLayerServices(workspaceAccess(open)),
  });
  return { open, harness };
};

/** What the Slack runtime passes for a connection open to the whole workspace. */
const workspaceContext = { ...slackContext, unlinkedRuntimeModeCeiling: UNLINKED_CEILING };

/** Starts work as `requester` and leaves it waiting on one question. */
const askQuestion = (requester: string) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    yield* gateway.ingest(
      slackInput("do: ship the fix", "ask-" + requester, undefined, requester),
      workspaceContext,
    );
    yield* runtime.drain;
    const task = yield* onlyTask;
    const threadId = task.worker?.threadId;
    assert(threadId !== undefined);
    yield* reports.report(
      {
        taskId: task.taskId,
        eventId: ChannelTaskEventId.make("question-" + requester),
        generation: task.generation,
        status: "waiting_input",
        summary: "Choose",
        question: "Staging or production?",
      },
      threadId,
    );
    return { task, threadId };
  });

const answerAs = (
  answerer: string,
  taskId: ChannelTask["taskId"],
  questionId: ChannelTask["openQuestions"][number]["questionId"],
) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* gateway.ingest(
      {
        ...slackInput("production", "answer-" + answerer, undefined, answerer),
        intent: "answer",
        taskId,
        questionId,
      },
      workspaceContext,
    );
    yield* runtime.drain;
    return yield* onlyTask;
  });

describe("Slack people without a linked account", () => {
  it.effect("start work under the connection's unlinked ceiling", () => {
    const { harness } = scenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      // The connection itself allows more; the unlinked ceiling still bounds the work.
      const result = yield* gateway.ingest(
        slackInput("do: fix the login bug", "Ev1", undefined, "U9"),
        {
          ...workspaceContext,
          runtimeModeCeiling: "full-access",
        },
      );
      assert.notStrictEqual(result.state, "rejected");
      yield* runtime.drain;
      const task = yield* onlyTask;
      assert.strictEqual(task.requester.principalId, "unlinked:slack-1:U9");
      assert.strictEqual(task.requester.runtimeModeCeiling, "approval-required");
      assert.deepStrictEqual(task.requester.grantedScopes, ["orchestration:operate"]);
      assert.strictEqual(harness.world.launches[0]?.runtimeMode, "approval-required");
      assert.isFalse(
        harness.slackSent.some((send) => send.message.text === CHANNEL_COPY.unlinkedInput),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("get only the link notice when the connection takes linked accounts only", () => {
    const { harness } = scenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      // A linked-only connection passes no unlinked ceiling.
      const result = yield* gateway.ingest(
        slackInput("do: something", "Ev2", undefined, "U9"),
        slackContext,
      );
      assert.strictEqual(result.state, "rejected");
      yield* runtime.drain;
      assert.deepStrictEqual(
        harness.slackSent.map((send) => [send.message.text, send.message.mentionActorId]),
        [[CHANNEL_COPY.unlinkedInput, "U9"]],
      );
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lose queued work when the connection switches to linked accounts only", () => {
    const { open, harness } = scenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(
        slackInput("do: fix the login bug", "Ev3", undefined, "U9"),
        workspaceContext,
      );
      open.current = false;
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("may answer another unlinked person's question at the same ceiling", () => {
    const { harness } = scenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const { task, threadId } = yield* askQuestion("U8");
      harness.world.setStatus(threadId, 1, "completed");
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* runtime.drain;
      const waiting = yield* onlyTask;
      const questionId = waiting.openQuestions[0]?.questionId;
      assert(questionId !== undefined);
      const after = yield* answerAs("U9", task.taskId, questionId);
      assert.strictEqual(after.openQuestions.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("may not answer a linked person's question that runs above their ceiling", () => {
    const { harness } = scenario();
    return Effect.gen(function* () {
      yield* setupBot;
      // U1's link allows auto-accept-edits, above the unlinked approval-required.
      yield* linkSlackUser("U1");
      const { task, threadId } = yield* askQuestion("U1");
      harness.world.setStatus(threadId, 1, "completed");
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* runtime.drain;
      const waiting = yield* onlyTask;
      const questionId = waiting.openQuestions[0]?.questionId;
      assert(questionId !== undefined);
      const after = yield* answerAs("U9", task.taskId, questionId);
      assert.deepStrictEqual(after.openQuestions, waiting.openQuestions);
      assert.strictEqual(harness.world.sends.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});
