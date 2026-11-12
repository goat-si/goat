import { assert, describe, it } from "@effect/vitest";
import {
  ChannelGatewayError,
  type ChannelIngestInput,
  type ChannelOutboundMessage,
  NodeId,
  ProjectId,
  type OrchestrationV2RuntimeRequest,
  RuntimeRequestId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as ChannelGateway from "./ChannelGateway.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { handleSlackEnvelope } from "./slack/SlackChannelAdapter.ts";
import { slackOutboundPosts } from "./slack/slackMessageFormatting.ts";
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
  channelScope: "listed" as const,
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
  it.effect("names a Slack approval's words, Deny first, with buttons and no numbers", () => {
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
        "deploy staging: the agent wants to run a command.\n" +
          CHANNEL_COPY.approvalDetailNotShown +
          '\nReply "Deny A1" or "Approve A1".',
      );
      assert.deepStrictEqual(card?.message.options, ["Deny A1", "Approve A1"]);

      yield* gateway.ingest(slackInput("9", "Ev9"), slackContext);
      yield* gateway.ingest(slackInput("0", "Ev0"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(responses(harness).length, 0);
      assert.notInclude(seen, "9");
      assert.notInclude(seen, "0");
    }).pipe(Effect.provide(harness.layer));
  });

  /** An iMessage chat; a message whose text holds one of the held words never sends. */
  const imessageChat = (held: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const sent: Array<ChannelOutboundMessage> = [];
      const registry = yield* ChannelTransport.ChannelTransportRegistry;
      yield* registry.register({
        kind: "imessage",
        send: (message) => {
          if (held.some((word) => message.text.includes(word)))
            return Effect.fail(new ChannelGatewayError({ reason: "delivery_failed" }));
          sent.push(message);
          return Effect.succeed({
            deliveryId: message.deliveryId,
            acceptedAt: "2026-10-12T00:00:01.000Z",
          });
        },
      });
      yield* linkImessage;
      return sent;
    });

  /** Two tasks in one iMessage chat, both with workers. */
  const twoTasks = Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    yield* gateway.ingest(imessageInput("do: ship the build", "row-1"), imessageContext);
    yield* runtime.drain;
    const first = yield* onlyTask;
    yield* gateway.ingest(imessageInput("do: drop the cache", "row-2"), imessageContext);
    yield* runtime.drain;
    const second = (yield* ledger.listConversationTasks(first.conversationId)).find(
      (task) => task.taskId !== first.taskId,
    )!;
    return { first: first.worker!.threadId, second: second.worker!.threadId };
  });

  // Cards once listed numbers Approve first, for a few hours Deny first, and an older server
  // still lists them. No number answers an approval, so no order can flip what one means.
  it.effect.each(["1", "2"])(
    'the number "%s" answers no approval and is told the words; "deny A1" then declines',
    (number) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const sent = yield* imessageChat();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(imessageInput("do: ship the build", "row-1"), imessageContext);
        yield* runtime.drain;
        const task = yield* onlyTask;
        const request = approval("ship");
        harness.world.runtimeRequests.set(task.worker!.threadId, [request]);
        harness.world.approvalPrompts.set(request.id, "make release");
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        assert.strictEqual(
          sent.find((message) => message.kind === "question")?.text,
          'ship the build: the agent wants to run a command.\nmake release\nReply "Deny A1" or "Approve A1".',
        );

        yield* gateway.ingest(imessageInput(number, "row-2"), imessageContext);
        yield* runtime.drain;
        assert.strictEqual(responses(harness).length, 0);
        const refusal = sent.at(-1)?.text ?? "";
        assert.include(refusal, CHANNEL_COPY.approvalNotByNumber);
        assert.include(
          refusal,
          "A1: ship the build: the agent wants to run a command.\nmake release",
        );
        assert.include(refusal, 'Reply "Deny A1" or "Approve A1".');

        yield* gateway.ingest(imessageInput("deny A1", "row-3"), imessageContext);
        yield* runtime.drain;
        const [answered] = responses(harness);
        assert.strictEqual(answered?.decision, "decline");
        assert.strictEqual(answered?.requestId, request.id);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a number approves nothing while a newer approval's card never reached the chat",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* imessageChat(["drop the cache:"]);
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const workers = yield* twoTasks;
        harness.world.runtimeRequests.set(workers.first, [approval("ship")]);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        // The second task's card fails to send: the person has only seen the first.
        harness.world.runtimeRequests.set(workers.second, [approval("cache")]);
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;

        yield* gateway.ingest(imessageInput("1", "row-3"), imessageContext);
        yield* runtime.drain;
        assert.deepStrictEqual(responses(harness), []);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a bare approve answers nothing: the bot repeats the request and asks for its code",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const sent = yield* imessageChat();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(imessageInput("do: ship the build", "row-1"), imessageContext);
        yield* runtime.drain;
        const task = yield* onlyTask;
        const request = approval("ship");
        harness.world.runtimeRequests.set(task.worker!.threadId, [request]);
        harness.world.approvalPrompts.set(request.id, "make release");
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;

        yield* gateway.ingest(imessageInput("approve", "row-2"), imessageContext);
        yield* runtime.drain;
        assert.deepStrictEqual(responses(harness), []);
        const asked = sent.at(-1)?.text ?? "";
        assert.include(asked, CHANNEL_COPY.approvalNeedsCode);
        assert.include(
          asked,
          "A1: ship the build: the agent wants to run a command.\nmake release",
        );
        assert.include(asked, 'Reply "Deny A1" or "Approve A1".');

        yield* gateway.ingest(imessageInput("Approve A1", "row-3"), imessageContext);
        yield* runtime.drain;
        const [answered] = responses(harness);
        assert.strictEqual(answered?.decision, "accept");
        assert.strictEqual(answered?.requestId, request.id);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  // Hangul typed on a Mac can arrive decomposed; "승인 A1" must read the same either way.
  it.effect("a decomposed Korean approval word with its code answers the approval", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* imessageChat();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(imessageInput("do: ship the build", "row-1"), imessageContext);
      yield* runtime.drain;
      const request = approval("ship");
      harness.world.runtimeRequests.set((yield* onlyTask).worker!.threadId, [request]);
      harness.world.approvalPrompts.set(request.id, "make release");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;

      const decomposed = "승인 A1".normalize("NFD");
      assert.notStrictEqual(decomposed, "승인 A1");
      yield* gateway.ingest(imessageInput(decomposed, "row-2"), imessageContext);
      yield* runtime.drain;
      const [answered] = responses(harness);
      assert.strictEqual(answered?.decision, "accept");
      assert.strictEqual(answered?.requestId, request.id);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a bare approve sent before a newer approval existed does not approve that one", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const sent = yield* imessageChat();
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const workers = yield* twoTasks;
      harness.world.runtimeRequests.set(workers.first, [approval("ship")]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;

      // The person answers the one card they see. Before the bot reads the reply, that approval
      // is answered in GOAT and another task asks for one.
      yield* gateway.ingest(imessageInput("approve", "row-3"), imessageContext);
      harness.world.runtimeRequests.set(workers.first, []);
      harness.world.runtimeRequests.set(workers.second, [approval("cache")]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.deepStrictEqual(responses(harness), []);
      assert.notInclude(sent.at(-1)?.text ?? "", "Approved.");
    }).pipe(Effect.provide(harness.layer));
  });

  // Prompts are optional, and a read can fail or miss the run that asked: a kind alone
  // ("wants to run a command") does not say what would be approved.
  it.effect.each(["the thread can't be read", "the request has no prompt"])(
    "offers no words for a request it can't show: %s",
    (why) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const sent = yield* imessageChat();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(imessageInput("do: ship the build", "row-1"), imessageContext);
        yield* runtime.drain;
        const worker = (yield* onlyTask).worker!.threadId;
        const request = approval("ship");
        harness.world.runtimeRequests.set(worker, [request]);
        if (why === "the thread can't be read") harness.world.approvalPrompts.set(request.id, "x");
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;

        if (why === "the thread can't be read") harness.world.recordFailures.add(worker);
        yield* gateway.ingest(imessageInput("approve", "row-2"), imessageContext);
        yield* runtime.drain;
        assert.deepStrictEqual(responses(harness), []);
        const asked = sent.at(-1)?.text ?? "";
        assert.include(asked, "A1: ship the build: " + CHANNEL_COPY.approvalDetailUnreadable);
        assert.notInclude(asked, "Approve A1");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  // Slack escapes "&" to "&amp;" and keeps every button, so each request's prompt must survive
  // the adapter's own formatting: the messages it posts and the section blocks of the last one.
  it.effect("keeps every repeated request's prompt visible in what Slack shows", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(slackInput("do: deploy " + "x".repeat(3000), "Ev1"), slackContext);
      yield* runtime.drain;
      const worker = (yield* onlyTask).worker!.threadId;
      const requests = ["one", "two", "three"].map(approval);
      // One message of about 3,400 characters once escaped: past the section cut, under the split.
      const prompts = ["run0 " + "&".repeat(390), "run1 " + "&".repeat(150), "run2 last"];
      harness.world.runtimeRequests.set(worker, requests);
      for (const [index, request] of requests.entries()) {
        harness.world.approvalPrompts.set(request.id, prompts[index]!);
      }
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;

      yield* gateway.ingest(slackInput("approve", "Ev2"), slackContext);
      yield* runtime.drain;
      const asked = resultsTo(harness.slackSent, "question").at(-1)?.message;
      assert.include(asked?.text ?? "", CHANNEL_COPY.approvalNeedsCode);
      // What Slack shows: a plain post's text, or the section of the post carrying the buttons.
      const shown = slackOutboundPosts({ text: asked?.text ?? "", options: asked?.options })
        .flatMap((post) =>
          (post.blocks ?? [{ type: "section" as const, text: { text: post.text } }]).flatMap(
            (block) => (block.type === "section" ? [block.text.text] : []),
          ),
        )
        .join("\n");
      for (const prompt of prompts) assert.include(shown, prompt.replaceAll("&", "&amp;"));
    }).pipe(Effect.provide(harness.layer));
  });

  // A card sent before this change listed "1. Approve A1 / 2. Deny A1"; a number typed for it
  // must not land on a question asked since.
  it.effect("with an approval open, a number answers no question either", () => {
    const harness = makeHarness({ projects: 2 });
    return Effect.gen(function* () {
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(slackInput("do: deploy staging", "Ev1"), slackContext);
      yield* runtime.drain;
      yield* gateway.ingest(slackInput("1", "Ev2"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches.length, 1);
      const worker = (yield* onlyTask).worker!.threadId;
      harness.world.runtimeRequests.set(worker, [approval("deploy")]);
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      yield* TestClock.adjust("1 second");
      yield* gateway.ingest(slackInput("do: which repo?", "Ev3"), slackContext);
      yield* runtime.drain;

      yield* gateway.ingest(slackInput("2", "Ev4"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches.length, 1);
      assert.strictEqual(responses(harness).length, 0);
      const refusal = resultsTo(harness.slackSent, "question").at(-1)?.message.text ?? "";
      assert.include(refusal, CHANNEL_COPY.approvalNotByNumber);
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
