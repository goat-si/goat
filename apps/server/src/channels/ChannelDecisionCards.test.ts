import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelIngestInput,
  type ChannelOutboundMessage,
  NodeId,
  ProjectId,
  type OrchestrationV2RuntimeRequest,
  RuntimeRequestId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ChannelGateway from "./ChannelGateway.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { handleSlackEnvelope } from "./slack/SlackChannelAdapter.ts";
import {
  defaultScript,
  linkSlackUser,
  makeHarness,
  onlyTask,
  owner,
  projectId,
  resultsTo,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const approval = (id: string): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make("approval:" + id),
  nodeId: NodeId.make("node:" + id),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: DateTime.makeUnsafe("2026-10-12T00:01:00.000Z"),
  resolvedAt: null,
});

const responses = (harness: ReturnType<typeof makeHarness>) =>
  harness.world.commands.flatMap((command) =>
    command.type === "runtime-request.respond" ? [command] : [],
  );

const chatGuid = "iMessage;-;+15551234567";
const imessageContext = {
  ...owner,
  caller: { type: "transport" as const, kind: "imessage" as const, connectionId: "imessage-1" },
};

const imessageInput = (text: string, key: string): ChannelIngestInput => ({
  kind: "imessage",
  connectionId: "imessage-1",
  conversationKey: chatGuid,
  externalMessageId: key,
  idempotencyKey: "imessage-1:" + key,
  actor: { externalActorId: "+15551234567" },
  replyAddress: { kind: "imessage", connectionId: "imessage-1", chatGuid },
  text,
  attachments: [],
  receivedAt: "2026-10-12T00:00:00.000Z",
  intent: "message",
});

const linkImessage = Effect.gen(function* () {
  const identities = yield* ChannelIdentityService.ChannelIdentityService;
  const gateway = yield* ChannelGateway.ChannelGateway;
  const { code } = yield* identities.createLink(
    { connectionId: "imessage-1", runtimeModeCeiling: "auto-accept-edits" },
    owner,
  );
  yield* gateway.linkIdentity(
    {
      connectionId: "imessage-1",
      externalActorId: "+15551234567",
      code,
      idempotencyKey: "link-imessage",
      replyAddress: { kind: "imessage", connectionId: "imessage-1", chatGuid },
    },
    imessageContext,
  );
});

const slackClassifier = {
  teamId: "T1",
  botUserId: "U0BOT",
  allowedChannelIds: new Set(["C1"]),
};

/** A choice button on the card posted into the Slack thread the harness uses. */
const blockActions = (input: {
  readonly userId: string;
  readonly value: string;
  readonly actionId?: string;
  readonly actionTs?: string;
}) => ({
  type: "block_actions" as const,
  team: { id: "T1", domain: "ignored" },
  user: { id: input.userId, username: "ignored", name: "Ignored" },
  channel: { id: "C1", name: "general" },
  message: {
    type: "message",
    user: "U0BOT",
    ts: "1760000000.000200",
    thread_ts: "1760000000.000100",
    text: "card",
  },
  actions: [
    {
      type: "button",
      action_id: input.actionId ?? "goat_choice_1",
      block_id: "goat_choices",
      value: input.value,
      action_ts: input.actionTs ?? "1760000001.000100",
    },
  ],
  token: "xoxb-secret",
  response_url: "https://hooks.slack.com/actions/nope",
  trigger_id: "1337.not.used",
});

const pressButton = (body: unknown) =>
  handleSlackEnvelope(
    {
      envelopeId: "env-button",
      type: "interactive",
      body,
      retryNum: undefined,
      retryReason: undefined,
      ack: () => Promise.resolve(),
    },
    { connectionId: "slack-1", classifier: slackClassifier, owner },
  );

const projectFor = (label: string) => {
  if (label === "Channel work") return projectId;
  const index = /^Other work (\d+)$/.exec(label)?.[1];
  return index === undefined ? undefined : ProjectId.make("project:channel-work-" + index);
};

describe("decision cards", () => {
  it.effect("lists Slack approval choices as a numbered list", () => {
    const harness = makeHarness();
    const seen: string[] = [];
    harness.script.current = (input) => {
      if (input.mode === "input" && input.inputText !== undefined) seen.push(input.inputText);
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(slackInput("do: deploy staging", "Ev1"), slackContext);
      yield* runtime.drain;
      const worker = (yield* onlyTask).worker!.threadId;
      harness.world.runtimeRequests.set(worker, [approval("deploy")]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const card = resultsTo(harness.slackSent, "question")[0];
      assert.strictEqual(
        card?.message.text,
        "deploy staging: the agent wants to run a command.\n1. Approve A1\n2. Deny A1",
      );
      assert.deepStrictEqual(card?.message.options, ["Approve A1", "Deny A1"]);

      // Out of range is an ordinary message. The approval stays unanswered.
      yield* gateway.ingest(slackInput("9", "Ev9"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(responses(harness).length, 0);
      assert.include(seen, "9");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lets an iMessage number deny the open approval", () => {
    const harness = makeHarness();
    const imessageSent: Array<ChannelOutboundMessage> = [];
    return Effect.gen(function* () {
      const registry = yield* ChannelTransport.ChannelTransportRegistry;
      yield* registry.register({
        kind: "imessage",
        send: (message) => {
          imessageSent.push(message);
          return Effect.succeed({
            deliveryId: message.deliveryId,
            acceptedAt: "2026-10-12T00:00:01.000Z",
          });
        },
      });
      yield* linkImessage;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(imessageInput("do: ship the build", "row-1"), imessageContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      const request = approval("ship");
      harness.world.runtimeRequests.set(task.worker!.threadId, [request]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const card = imessageSent.find((message) => message.kind === "question");
      assert.strictEqual(
        card?.text,
        "ship the build: the agent wants to run a command.\n1. Approve A1\n2. Deny A1",
      );
      assert.isUndefined(card?.options);

      yield* gateway.ingest(imessageInput("2", "row-2"), imessageContext);
      yield* runtime.drain;
      const [answered] = responses(harness);
      assert.strictEqual(answered?.decision, "decline");
      assert.strictEqual(answered?.requestId, request.id);
      assert.strictEqual(answered?.threadId, task.worker!.threadId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lets a number with nothing open through to the model", () => {
    const harness = makeHarness();
    const seen: string[] = [];
    harness.script.current = (input) => {
      if (input.mode === "input" && input.inputText !== undefined) seen.push(input.inputText);
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(slackInput("2", "Ev-empty"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(responses(harness).length, 0);
      assert.include(seen, "2");
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("approves from a Slack button and refuses who may not answer", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const { code } = yield* identities.createLink(
        {
          connectionId: "slack-1",
          runtimeModeCeiling: "approval-required",
          grantedScopes: ["orchestration:read"],
        },
        owner,
      );
      yield* gateway.linkIdentity(
        {
          connectionId: "slack-1",
          externalActorId: "U2",
          code,
          idempotencyKey: "link-U2",
          replyAddress: {
            kind: "slack",
            connectionId: "slack-1",
            teamId: "T1",
            channelId: "D1",
            rootTs: "1",
          },
        },
        slackContext,
      );
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(slackInput("do: deploy staging", "Ev1"), slackContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      const request = approval("deploy");
      harness.world.runtimeRequests.set(task.worker!.threadId, [request]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;

      const unlinked = yield* pressButton(
        blockActions({ userId: "U9", value: "Approve A1", actionTs: "1760000001.000200" }),
      );
      yield* runtime.drain;
      assert.strictEqual(unlinked.handling, "ingested");
      assert.strictEqual(responses(harness).length, 0);

      const refused = yield* pressButton(
        blockActions({ userId: "U2", value: "Approve A1", actionTs: "1760000001.000300" }),
      );
      yield* runtime.drain;
      assert.strictEqual(refused.handling, "ingested");
      assert.strictEqual(responses(harness).length, 0);

      const approved = yield* pressButton(
        blockActions({ userId: "U1", value: "Approve A1", actionTs: "1760000001.000100" }),
      );
      yield* runtime.drain;
      assert.strictEqual(approved.handling, "ingested");
      const [answered] = responses(harness);
      assert.strictEqual(answered?.decision, "accept");
      assert.strictEqual(answered?.requestId, request.id);
      assert.strictEqual(answered?.threadId, task.worker!.threadId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("answers a task question from its number without the model", () => {
    const harness = makeHarness({ projects: 2 });
    const seen: string[] = [];
    harness.script.current = (input) => {
      if (input.mode === "input" && input.inputText !== undefined) seen.push(input.inputText);
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(slackInput("do: which repo?", "Ev-q"), slackContext);
      yield* runtime.drain;
      const asked = yield* onlyTask;
      assert.strictEqual(asked.openQuestions.length, 1);
      const question = resultsTo(harness.slackSent, "question")[0];
      const second = question?.message.text.split("\n").find((line) => line.startsWith("2. "));
      assert.isDefined(second);
      const label = second!.slice("2. ".length);
      yield* gateway.ingest(slackInput("2", "Ev-n"), slackContext);
      yield* runtime.drain;
      assert.notInclude(seen, "2");
      assert.strictEqual(harness.world.launches.length, 1);
      assert.strictEqual(harness.world.launches[0]?.projectId, projectFor(label));
      assert.strictEqual((yield* onlyTask).openQuestions.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("answers a task question from the option's label without the model", () => {
    const harness = makeHarness({ projects: 2 });
    const seen: string[] = [];
    harness.script.current = (input) => {
      if (input.mode === "input" && input.inputText !== undefined) seen.push(input.inputText);
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(slackInput("do: which repo?", "Ev-q"), slackContext);
      yield* runtime.drain;
      const question = resultsTo(harness.slackSent, "question")[0];
      const first = question?.message.text.split("\n").find((line) => line.startsWith("1. "));
      assert.isDefined(first);
      const label = first!.slice("1. ".length);
      yield* gateway.ingest(slackInput(label.toLowerCase(), "Ev-label"), slackContext);
      yield* runtime.drain;
      assert.notInclude(seen, label.toLowerCase());
      assert.strictEqual(harness.world.launches.length, 1);
      assert.strictEqual(harness.world.launches[0]?.projectId, projectFor(label));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("tells a second answer to an answered question that it was not passed on", () => {
    const harness = makeHarness({ projects: 2 });
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(slackInput("do: which repo?", "Ev-q"), slackContext);
      yield* runtime.drain;
      const asked = yield* onlyTask;
      const questionId = asked.openQuestions[0]!.questionId;
      const question = resultsTo(harness.slackSent, "question")[0];
      const label = question!.message.text
        .split("\n")
        .find((line) => line.startsWith("1. "))!
        .slice("1. ".length);
      const answer = (key: string) =>
        gateway.ingest(
          { ...slackInput(label, key), intent: "answer", taskId: asked.taskId, questionId },
          slackContext,
        );
      yield* answer("Ev-first");
      yield* runtime.drain;
      yield* answer("Ev-again");
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches.length, 1);
      assert.strictEqual(
        resultsTo(harness.slackSent, "receipt").at(-1)?.message.text,
        CHANNEL_COPY.questionAlreadyAnswered,
      );
    }).pipe(Effect.provide(harness.layer));
  });
});
