/**
 * The assembled channel layer with the live Slack runtime and settings over a fake Slack SDK:
 * the R7 path (GOAT bot and Slack at once) and how Slack sockets end. Real Slack timing and the
 * web and desktop screens are checked by hand in the R7 demo; passing here is not R7.
 */
// @effect-diagnostics nodeBuiltinImport:off -- synthetic iMessage settings and database path only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  type ChannelInboundMessage,
  type SlackChannelDefaultTarget,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLayers from "./ChannelLayers.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import { makeImessageTransport } from "./imessage/imessageSender.ts";
import { makeLayerLive } from "./imessage/ImessageChannelRuntime.ts";
import {
  IMESSAGE_SETTINGS_FILE,
  type ImessageSettingsFile,
} from "./imessage/ImessageChannelSettings.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { channelMention, directMessage, eventCallback } from "./slack/slackChannelTestSupport.ts";
import { makeFakeSlackSdk, type FakeSlackSdk } from "./slack/slackSdkFake.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  makeHarness,
  modelSelection,
  owner,
  ownerId,
  projectId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const missingInstance = ProviderInstanceId.make("missing");

describe("iMessage transport assembly", () => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "darwin")(
    "registers the live transport only with enabled Mac settings",
    () => {
      const fixtureDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-layer-"));
      const sdk = makeFakeSlackSdk();
      const channelsLayer = liveChannels(
        sdk,
        offeredModels,
        makeLayerLive(NodePath.join(fixtureDir, "absent-chat.db")),
      );
      const harness = makeHarness({ channelsLayer, fakeSlackTransport: false });
      return Effect.gen(function* () {
        try {
          const config = yield* ServerConfig.ServerConfig;
          const registry = yield* ChannelTransport.ChannelTransportRegistry;
          const runtime = yield* claim;
          const settings: ImessageSettingsFile = {
            version: 1,
            enabled: false,
            connectionId: "imessage-000000000001",
            allowedHandles: ["+15550000000"],
            ownHandles: [],
            owner,
          };
          NodeFS.mkdirSync(config.stateDir, { recursive: true });
          const settingsPath = NodePath.join(config.stateDir, IMESSAGE_SETTINGS_FILE);
          NodeFS.writeFileSync(settingsPath, JSON.stringify(settings));
          yield* runtime.runPass;
          assert.isTrue(Option.isNone(yield* registry.resolve("imessage")));
          NodeFS.writeFileSync(settingsPath, JSON.stringify({ ...settings, enabled: true }));
          yield* runtime.runPass;
          assert.isTrue(Option.isSome(yield* registry.resolve("imessage")));
        } finally {
          NodeFS.rmdirSync(fixtureDir);
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect("requires the trusted transport caller and a linked requester", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const connectionId = "imessage-000000000001";
      const message: ChannelInboundMessage = {
        kind: "imessage",
        connectionId,
        conversationKey: "iMessage;-;+15550000000",
        externalMessageId: "guid-1",
        idempotencyKey: connectionId + ":1",
        actor: { externalActorId: "+15550000000" },
        replyAddress: { kind: "imessage", connectionId, chatGuid: "iMessage;-;+15550000000" },
        text: "hello",
        attachments: [],
        receivedAt: "2026-10-19T00:00:00.000Z",
        intent: "message",
      };
      const context = {
        ...owner,
        caller: { type: "transport" as const, kind: "imessage" as const, connectionId },
      };
      const accepted = yield* gateway.ingest(message, context);
      assert.strictEqual(accepted.state, "rejected");
      assert.isUndefined((yield* ledger.getInput(accepted.inputId))?.requester);
      const wrongKind = yield* Effect.result(
        gateway.ingest(
          { ...message, idempotencyKey: connectionId + ":2" },
          { ...owner, caller: { type: "transport", kind: "slack", connectionId } },
        ),
      );
      assert.strictEqual(wrongKind._tag, "Failure");
      const wrongConnection = yield* Effect.result(
        gateway.ingest(
          { ...message, idempotencyKey: connectionId + ":3" },
          { ...owner, caller: { type: "transport", kind: "imessage", connectionId: "other" } },
        ),
      );
      assert.strictEqual(wrongConnection._tag, "Failure");
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("registers only for its scope and releases on close", () =>
    Effect.gen(function* () {
      const registry = yield* ChannelTransport.ChannelTransportRegistry;
      const scope = yield* Scope.make();
      const transport = makeImessageTransport({
        connectionId: "imessage-000000000001",
        sender: { sendText: async () => ({ acceptedAt: "2026-10-19T00:00:00.000Z" }) },
        isActive: () => Effect.succeed(true),
      });
      yield* registry.register(transport).pipe(Effect.provideService(Scope.Scope, scope));
      assert.isTrue(Option.isSome(yield* registry.resolve("imessage")));
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Option.isNone(yield* registry.resolve("imessage")));
    }).pipe(Effect.provide(ChannelTransport.layer)),
  );
});
const serverModel = { instanceId: ProviderInstanceId.make("codex"), model: "server-default" };
/** What the fake providers list; anything else counts as not offered. */
const offeredModels = ["gpt-6.1-sol", "gpt-other", "server-default"];

/** The one signed-in Codex account on this machine, listing only the offered models. */
const codexInstance = (offered: ReadonlyArray<string>) =>
  ({
    instanceId: ProviderInstanceId.make("codex"),
    driverKind: "codex",
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed({
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: offered.map((slug) => ({ slug })),
      }),
    },
  }) as never;

/**
 * The server's channel graph with the live Slack layers; only the SDK is fake. Providers resolve
 * except the missing instance.
 */
const liveChannels = (
  sdk: FakeSlackSdk,
  offered: ReadonlyArray<string> = offeredModels,
  imessageLayer = makeLayerLive(),
) =>
  ChannelLayers.makeLayerServicesWithSlack(imessageLayer).pipe(
    Layer.provide(
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        quotaPool: Effect.succeed(undefined),
        projectProviders: (providers) => Effect.succeed(providers),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        sdk.layer,
        ServerSecretStore.layer,
        // A server default unlike every project's, so tests can tell which one applied.
        ServerSettings.layerTest({
          textGenerationModelSelection: serverModel,
          defaultRuntimeMode: "full-access",
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.succeed(id === missingInstance ? undefined : codexInstance(offered)),
          // Only the configured account, so placement keeps it.
          listInstances: Effect.succeed([codexInstance(offered)]),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.orDie,
  );

const harnessWithSlack = (
  options: { readonly projects?: number; readonly offered?: ReadonlyArray<string> } = {},
) => {
  const sdk = makeFakeSlackSdk();
  const harness = makeHarness({
    ...options,
    channelsLayer: liveChannels(sdk, options.offered),
    fakeSlackTransport: false,
  });
  return { ...harness, sdk };
};

/** Configures one Slack connection through the settings port and waits for its socket. */
const connectSlack = (defaultTarget?: SlackChannelDefaultTarget) =>
  Effect.gen(function* () {
    const settings = yield* SlackChannelSettings.SlackChannelSettings;
    const created = yield* settings.configure(
      {
        enabled: true,
        appToken: "xapp-1-fake",
        botToken: "xoxb-fake",
        allowedChannelIds: ["C0ALLOWED"],
        ...(defaultTarget === undefined ? {} : { defaultTarget }),
      },
      owner,
    );
    yield* settings.streamStatus().pipe(
      Stream.filter((event) => event.status === "connected"),
      Stream.runHead,
    );
    return created.connectionId;
  });

/** Sends one envelope on the newest socket and waits for its acknowledgement. */
const emit = (sdk: FakeSlackSdk, body: unknown) =>
  Effect.gen(function* () {
    const session = sdk.sessions.at(-1);
    if (session === undefined) return yield* Effect.die(new Error("no Slack session"));
    const envelope = session.emitEnvelope(body);
    yield* Effect.promise(() => envelope.acked);
    return envelope;
  });

/** Links Slack user U0ALICE the way a person does: a code made in GOAT, DMed to the bot. */
const linkAlice = (sdk: FakeSlackSdk, connectionId: string) =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const { code } = yield* identities.createLink(
      { connectionId, runtimeModeCeiling: "auto-accept-edits" },
      owner,
    );
    yield* emit(
      sdk,
      eventCallback(directMessage({ text: "link " + code }), { event_id: "EvLink" }),
    );
  });

const claim = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  yield* ledger.claimOwnership({
    token: runtime.ownerToken,
    now: "2026-10-12T00:00:00.000Z",
    staleBefore: "2026-10-11T00:00:00.000Z",
  });
  return runtime;
});

const slackRoot = "1760000000.000300";

describe("R7 path over the assembled layer (fake Slack SDK)", () => {
  it.effect("answers GOAT and Slack at once and returns each result to its own channel", () => {
    const harness = harnessWithSlack();
    return Effect.gen(function* () {
      yield* setupBot;
      const connectionId = yield* connectSlack();
      yield* linkAlice(harness.sdk, connectionId);
      const runtime = yield* claim;
      yield* runtime.drain;
      const linkNotices = harness.sdk.posted.length;

      // The GOAT bot's model call is held, so Slack's answer cannot be waiting behind it.
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      harness.script.current = (input) =>
        input.inputText === "do: goat job"
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(defaultScript(input)),
            )
          : defaultScript(input);

      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const [goat, slackEnvelope] = yield* Effect.all(
        [
          gateway.ingest(goatInput("do: goat job", "client-r7"), rpcContext),
          emit(
            harness.sdk,
            eventCallback(channelMention({ text: "<@U0BOT> do: slack job", ts: slackRoot }), {
              event_id: "EvR7Slack",
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(slackEnvelope.ackCount(), 1);
      const pending = yield* ledger.listPendingInputs(10);
      const slackInputId = pending.find((inputId) => inputId !== goat.inputId);
      assert.isDefined(slackInputId);

      yield* runtime.runPass;
      // GOAT's model call is now blocked; everything below happens while it waits.
      yield* Deferred.await(entered);
      yield* runtime.settle([slackInputId!]);
      yield* runtime.runPass;
      yield* runtime.runPass;

      // Slack got its first answer in its own thread while GOAT's reception was still held.
      const slackFirst = harness.sdk.posted.slice(linkNotices);
      assert.isTrue(
        slackFirst.some(
          (post) =>
            post.channel === "C0ALLOWED" &&
            post.threadTs === slackRoot &&
            post.text.includes("On it."),
        ),
      );
      assert.strictEqual((yield* ledger.getInput(goat.inputId))?.snapshot.state, "processing");

      yield* Deferred.succeed(gate, undefined);
      yield* runtime.drain;

      // Two tasks, each with its own worker thread and its own chip in the bot.
      const tasks = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      assert.strictEqual(tasks.length, 2);
      const goatTask = tasks.find((task) => task.originAddress.kind === "goat")!;
      const slackTask = tasks.find((task) => task.originAddress.kind === "slack")!;
      assert.notStrictEqual(goatTask.taskId, slackTask.taskId);
      assert.isDefined(goatTask.worker);
      assert.isDefined(slackTask.worker);
      assert.notStrictEqual(goatTask.worker!.threadId, slackTask.worker!.threadId);
      const records = yield* botMessages;
      const chips = records.turnItems.flatMap((item) =>
        item.type === "notification" && item.ledgerTask !== undefined ? [item.ledgerTask] : [],
      );
      assert.deepStrictEqual(
        chips.map((chip) => chip.taskId).toSorted(),
        [goatTask.taskId, slackTask.taskId].toSorted(),
      );
      assert.strictEqual(new Set(chips.map((chip) => chip.worker?.threadId)).size, 2);

      // Each worker finishes with a marker only its own channel may see.
      harness.world.setStatus(goatTask.worker!.threadId, 1, "completed", "GOAT-RESULT-7A");
      harness.world.setStatus(slackTask.worker!.threadId, 1, "completed", "SLACK-RESULT-7B");
      yield* runtime.drain;
      assert.strictEqual(
        (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks.filter(
          (task) => task.status === "completed",
        ).length,
        2,
      );

      const slackTexts = harness.sdk.posted.map((post) => post.text).join("\n");
      assert.include(slackTexts, "SLACK-RESULT-7B");
      assert.notInclude(slackTexts, "GOAT-RESULT-7A");
      assert.isTrue(
        harness.sdk.posted.every(
          (post) => !post.text.includes("SLACK-RESULT-7B") || post.threadTs === slackRoot,
        ),
      );
      // The bot shows GOAT's conversation in full, but for Slack's task only its chip, which
      // carries the result; the Slack request and Slack's answers stay in Slack.
      const after = yield* botMessages;
      assert.deepStrictEqual(
        after.messages.filter(
          (message) =>
            message.channel?.taskId === slackTask.taskId ||
            message.channel?.conversationId === slackTask.conversationId,
        ),
        [],
      );
      const cards = new Map(
        after.turnItems.flatMap((item) =>
          item.type === "notification" && item.ledgerTask !== undefined
            ? [[item.ledgerTask.taskId, item.ledgerTask] as const]
            : [],
        ),
      );
      assert.strictEqual(cards.get(slackTask.taskId)?.summary, "SLACK-RESULT-7B");
      assert.strictEqual(cards.get(goatTask.taskId)?.summary, "GOAT-RESULT-7A");
      const botTexts = after.messages.map((message) => message.text).join("\n");
      assert.notInclude(botTexts, "GOAT-RESULT-7A");
      assert.notInclude(botTexts, "do: slack job");
      assert.deepStrictEqual(after.runs, []);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("Slack connection lifetime", () => {
  it.effect("closes the socket and drops the transport when the channel layer shuts down", () =>
    Effect.gen(function* () {
      const harness = harnessWithSlack();
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const registry = Context.get(context, ChannelTransport.ChannelTransportRegistry);
      yield* connectSlack().pipe(Effect.provide(context));
      assert.isTrue(Option.isSome(yield* registry.resolve("slack")));
      const session = harness.sdk.sessions[0]!;
      assert.isAbove(session.listenerCount(), 0);

      yield* Scope.close(scope, Exit.void);
      assert.include(harness.sdk.calls, "disconnect:0");
      assert.isTrue(Option.isNone(yield* registry.resolve("slack")));
      assert.strictEqual(session.listenerCount(), 0);
      // An envelope after shutdown is never acknowledged, so Slack keeps it for redelivery.
      assert.strictEqual(session.emitEnvelope(eventCallback(channelMention())).ackCount(), 0);
    }),
  );

  it.effect("absorbs redelivery of input stored before its acknowledgement got through", () => {
    const harness = harnessWithSlack();
    return Effect.gen(function* () {
      yield* setupBot;
      const connectionId = yield* connectSlack();
      yield* linkAlice(harness.sdk, connectionId);
      const runtime = yield* claim;
      const body = eventCallback(channelMention({ text: "<@U0BOT> do: once", ts: slackRoot }), {
        event_id: "EvOnce",
      });
      // The input is stored, then the acknowledgement never completes and the socket drops.
      const first = harness.sdk.sessions[0]!.emitEnvelope(body, {
        ack: () => new Promise<void>(() => {}),
      });
      yield* Effect.promise(() => first.acked);
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.strictEqual((yield* ledger.listPendingInputs(10)).length, 1);
      const settings = yield* SlackChannelSettings.SlackChannelSettings;
      yield* settings.disconnect({ connectionId });
      // A socket that is gone acknowledges nothing, so Slack keeps the event.
      const dropped = harness.sdk.sessions[0]!;
      assert.strictEqual(dropped.emitEnvelope(body).ackCount(), 0);
      yield* settings.configure({ connectionId, enabled: true }, owner);
      yield* settings.streamStatus().pipe(
        Stream.filter((event) => event.status === "connected"),
        Stream.runHead,
      );
      assert.strictEqual(harness.sdk.sessions.length, 2);
      const redelivered = yield* emit(harness.sdk, body);
      assert.strictEqual(redelivered.ackCount(), 1);

      assert.strictEqual((yield* ledger.listPendingInputs(10)).length, 1);
      yield* runtime.drain;
      const tasks = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(harness.world.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("Slack connection lifetime, interrupted mid-envelope", () => {
  it.effect("neither loses nor repeats an event cut off at any point by a disconnect", () => {
    const harness = harnessWithSlack();
    return Effect.gen(function* () {
      yield* setupBot;
      const connectionId = yield* connectSlack();
      yield* linkAlice(harness.sdk, connectionId);
      const runtime = yield* claim;
      const settings = yield* SlackChannelSettings.SlackChannelSettings;
      const body = eventCallback(channelMention({ text: "<@U0BOT> do: cut", ts: slackRoot }), {
        event_id: "EvCutOff",
      });
      // The disconnect races the envelope's handling: it may stop before or after the store.
      const first = harness.sdk.sessions[0]!.emitEnvelope(body);
      yield* settings.disconnect({ connectionId });
      const ledger = yield* ChannelLedger.ChannelLedger;
      const storedBeforeReplay = (yield* ledger.listPendingInputs(10)).length;
      assert.isAtMost(first.ackCount(), storedBeforeReplay);

      yield* settings.configure({ connectionId, enabled: true }, owner);
      yield* settings.streamStatus().pipe(
        Stream.filter((event) => event.status === "connected"),
        Stream.runHead,
      );
      yield* emit(harness.sdk, body);
      assert.strictEqual((yield* ledger.listPendingInputs(10)).length, 1);
      yield* runtime.drain;
      assert.strictEqual((yield* ledger.listTasks({ ownerId, limit: 10 })).tasks.length, 1);
      assert.strictEqual(harness.world.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("Slack default work target", () => {
  const otherProject = ProjectId.make("project:channel-work-1");
  const otherModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-other" } as const;

  const slackTask = (
    harness: ReturnType<typeof harnessWithSlack>,
    defaultTarget: SlackChannelDefaultTarget,
  ) =>
    Effect.gen(function* () {
      yield* setupBot;
      const connectionId = yield* connectSlack(defaultTarget);
      yield* linkAlice(harness.sdk, connectionId);
      const runtime = yield* claim;
      yield* emit(
        harness.sdk,
        eventCallback(channelMention({ text: "<@U0BOT> do: target job", ts: slackRoot }), {
          event_id: "EvTarget",
        }),
      );
      yield* runtime.drain;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      return task!;
    });

  it.effect("starts Slack work in the connection's default project and model", () => {
    const harness = harnessWithSlack({ projects: 2 });
    return Effect.gen(function* () {
      const task = yield* slackTask(harness, {
        projectId: otherProject,
        modelSelection: otherModel,
      });
      assert.strictEqual(task.status, "running");
      assert.strictEqual(harness.world.launches[0]?.projectId, otherProject);
      assert.deepStrictEqual(harness.world.launches[0]?.modelSelection, otherModel);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a project named with the work and still applies the default model", () => {
    const harness = harnessWithSlack({ projects: 2 });
    return Effect.gen(function* () {
      harness.script.current = (input) =>
        input.mode === "task_event"
          ? defaultScript(input)
          : Effect.succeed({
              replyText: "On it.",
              action: {
                type: "create_task",
                title: "target job",
                instruction: "target job",
                projectId,
              },
            });
      yield* slackTask(harness, { projectId: otherProject, modelSelection: otherModel });
      assert.strictEqual(harness.world.launches[0]?.projectId, projectId);
      assert.deepStrictEqual(harness.world.launches[0]?.modelSelection, otherModel);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("uses the project's own model when only a default project is set", () => {
    const harness = harnessWithSlack({ projects: 2 });
    return Effect.gen(function* () {
      yield* slackTask(harness, { projectId: otherProject });
      assert.strictEqual(harness.world.launches[0]?.projectId, otherProject);
      assert.deepStrictEqual(harness.world.launches[0]?.modelSelection, modelSelection);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("uses only the default model when no default project is set", () => {
    const harness = harnessWithSlack();
    return Effect.gen(function* () {
      yield* slackTask(harness, { modelSelection: otherModel });
      assert.strictEqual(harness.world.launches[0]?.projectId, projectId);
      assert.deepStrictEqual(harness.world.launches[0]?.modelSelection, otherModel);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks instead of picking another project when the default one is gone", () => {
    // With one project, ignoring the default would start work there; it must ask instead.
    const harness = harnessWithSlack();
    return Effect.gen(function* () {
      const task = yield* slackTask(harness, { projectId: ProjectId.make("project:deleted") });
      assert.strictEqual(task.status, "waiting_input");
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("falls back to the project's model when the Slack default provider is gone", () => {
    const harness = harnessWithSlack();
    return Effect.gen(function* () {
      const task = yield* slackTask(harness, {
        modelSelection: { instanceId: missingInstance, model: "gone" },
      });
      assert.strictEqual(task.status, "running");
      assert.deepStrictEqual(harness.world.launches[0]?.modelSelection, modelSelection);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("falls back to the project's model when the provider no longer lists it", () => {
    const harness = harnessWithSlack();
    return Effect.gen(function* () {
      const task = yield* slackTask(harness, {
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "retired" },
      });
      assert.strictEqual(task.status, "running");
      assert.deepStrictEqual(harness.world.launches[0]?.modelSelection, modelSelection);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks when neither the Slack model nor the project's is offered", () => {
    // Only the server default is listed: the project's own model is retired too.
    const harness = harnessWithSlack({ offered: ["server-default"] });
    return Effect.gen(function* () {
      const task = yield* slackTask(harness, {
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "retired" },
      });
      assert.strictEqual(task.status, "waiting_input");
      assert.include(
        task.openQuestions[0]?.text ?? "",
        "No ready account offers the requested model",
      );
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ignores Slack defaults for work from the GOAT bot", () => {
    const harness = harnessWithSlack({ projects: 2 });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* connectSlack({ projectId: otherProject, modelSelection: otherModel });
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* claim;
      yield* gateway.ingest(goatInput("do: bot job", "client-target"), rpcContext);
      yield* runtime.drain;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const [task] = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
      assert.strictEqual(task?.status, "waiting_input");
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});
