import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  type ChannelReceptionInput,
  ProviderTurnId,
  ProviderDriverKind,
  type RuntimeMode,
} from "@goat/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { nextTurnSelectionHarness } from "../../orchestration-v2/testkit/SteeringHarness.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ChannelBotThreads from "../ChannelBotThreads.ts";
import * as ChannelBotMembers from "../ChannelBotMembers.ts";
import { channelBotFilesFor, readChannelBotNotesSnapshot } from "../channelBotNotes.ts";
import * as ChannelIdentityService from "../ChannelIdentityService.ts";
import * as ChannelLedger from "../ChannelLedger.ts";
import * as ChannelRuntime from "../ChannelRuntime.ts";
import { CHANNEL_COPY } from "../channelCopy.ts";
import { inputIdFor } from "../channelIds.ts";
import {
  defaultScript,
  makeHarness,
  modelSelection,
  owner,
  ownerId,
  setupBot,
} from "../testkit/ChannelHarness.ts";
import * as SlackChannelSettings from "../SlackChannelSettings.ts";
import * as SlackChannelSettingsLive from "./SlackChannelSettings.live.ts";
import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import { channelMention, directMessage, eventCallback } from "./slackChannelTestSupport.ts";
import { makeFakeSlackSdk, type FakeSlackSdk } from "./slackSdkFake.ts";

/**
 * The live Slack runtime against the real channel core: gateway, ledger, reception, and the
 * delivery worker from the channel test harness, with only the Slack SDK faked. These cover what
 * the adapter alone cannot prove: one stored input per Slack event, no work for unlinked users,
 * and how the outbox treats Slack's delivery failures.
 */

const connectionId = "slack-1";
const ROOT_TS = "1760000000.000100";

const slackScenario = (options: Parameters<typeof makeHarness>[0] = {}) => {
  const sdk = makeFakeSlackSdk();
  const harness = makeHarness({ ...options, fakeSlackTransport: false });
  const runtime = SlackChannelRuntime.layer.pipe(Layer.provide(sdk.layer));
  const layer = SlackChannelSettingsLive.layer.pipe(
    Layer.provide(sdk.layer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(runtime),
    Layer.provideMerge(harness.layer),
  );
  return { sdk, harness, layer };
};

const connect = (
  _sdk: FakeSlackSdk,
  options: {
    readonly botBindings?: ReadonlyArray<{ readonly channelId: string; readonly botId: BotId }>;
    readonly unlinkedRuntimeModeCeiling?: RuntimeMode;
    readonly owner?: typeof owner;
  } = {},
) =>
  Effect.gen(function* () {
    const runtime = yield* SlackChannelRuntime.SlackChannelRuntime;
    yield* runtime.apply({
      connectionId,
      enabled: true,
      channelScope: "listed",
      allowedChannelIds: ["C0ALLOWED"],
      appToken: "xapp-1-test",
      botToken: "xoxb-test",
      expectedTeamId: "T0TEAM",
      owner,
      ...options,
    });
    yield* runtime.streamStatus.pipe(
      Stream.filter((event) => event.connectionId === connectionId && event.status === "connected"),
      Stream.runHead,
    );
  });

const emit = (sdk: FakeSlackSdk, event: Record<string, unknown>, eventId: string) => {
  const session = sdk.sessions.at(-1);
  assert(session !== undefined);
  const envelope = session.emitEnvelope(eventCallback(event, { event_id: eventId }));
  return Effect.promise(() => envelope.acked).pipe(Effect.as(envelope));
};

const linkAlice = (sdk: FakeSlackSdk, linkOwner = owner) =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const { code } = yield* identities.createLink(
      { connectionId, runtimeModeCeiling: "auto-accept-edits" },
      linkOwner,
    );
    yield* emit(sdk, directMessage({ text: `link ${code}` }), "EvLinkAlice01");
  });

const tasks = Effect.flatMap(ChannelLedger.ChannelLedger, (ledger) =>
  ledger.listTasks({ ownerId, limit: 10 }),
);

const createBot = (name: string) =>
  Effect.flatMap(ChannelBotMembers.ChannelBotMembers, (members) =>
    members.create(
      { clientRequestId: name, name, purpose: "", avatar: null, defaultModelSelection: null },
      owner,
    ),
  );

const eventInputId = (eventId: string) =>
  inputIdFor({ ownerId, kind: "slack", connectionId, idempotencyKey: "T0TEAM:" + eventId });

const receive = (sdk: FakeSlackSdk, event: Record<string, unknown>, eventId: string) =>
  Effect.gen(function* () {
    yield* emit(sdk, event, eventId);
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
    return yield* (yield* ChannelLedger.ChannelLedger).getInput(eventInputId(eventId));
  });

describe("Slack runtime on the channel core", () => {
  it.effect(
    "pins the first admitted Slack message across rebinding, renaming and unbinding",
    () => {
      const { sdk, layer } = slackScenario();
      return Effect.gen(function* () {
        yield* setupBot;
        const scout = yield* createBot("Scout");
        const builder = yield* createBot("Builder");
        yield* connect(sdk, { botBindings: [{ channelId: "C0ALLOWED", botId: scout.botId }] });
        yield* linkAlice(sdk);
        const first = yield* receive(
          sdk,
          channelMention({ text: "<@U0BOT> Check the build", ts: ROOT_TS }),
          "EvNamedBound01",
        );
        assert.strictEqual(first?.botId, scout.botId);
        assert.include(sdk.posted.find((post) => post.threadTs === ROOT_TS)?.text ?? "", "Scout:");
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        yield* members.update({ botId: scout.botId, name: "Navigator" }, owner);
        yield* connect(sdk, { botBindings: [{ channelId: "C0ALLOWED", botId: builder.botId }] });
        const reply = yield* receive(
          sdk,
          channelMention({
            text: "<@U0BOT> Builder: status?",
            ts: "1760000001.000101",
            thread_ts: ROOT_TS,
          }),
          "EvNamedReply01",
        );
        assert.strictEqual(reply?.botId, scout.botId);
        yield* connect(sdk);
        const unbound = yield* receive(
          sdk,
          channelMention({ ts: "1760000002.000102" }),
          "EvNamedUnbound",
        );
        assert.strictEqual(unbound?.botId, "main");
        const dm = yield* receive(
          sdk,
          directMessage({ text: "navigator: do: check the logs" }),
          "EvNamedDm01",
        );
        assert.strictEqual(dm?.botId, scout.botId);
        assert.strictEqual(dm?.message.text, "do: check the logs");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps a Slack thread admitted by an older server with Main", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const scout = yield* createBot("Scout");
      const sql = yield* SqlClient.SqlClient;
      yield* connect(sdk);
      yield* linkAlice(sdk);
      const original = yield* receive(sdk, channelMention(), "EvLegacyFirst");
      assert.strictEqual(original?.botId, "main");
      // Simulate the row as an older writer leaves it after adding the nullable column.
      yield* sql`UPDATE channel_conversations SET slack_bot_id = NULL WHERE conversation_id = ${original?.snapshot.conversationId}`;
      yield* connect(sdk, { botBindings: [{ channelId: "C0ALLOWED", botId: scout.botId }] });
      const reply = yield* receive(
        sdk,
        channelMention({
          text: "<@U0BOT> Scout: hello",
          ts: "1760000002.000102",
          thread_ts: ROOT_TS,
        }),
        "EvLegacyReply",
      );
      assert.strictEqual(reply?.botId, "main");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps unknown, hidden, deleted and ambiguous targets private", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      yield* createBot("Scout");
      const hidden = yield* createBot("Hidden");
      const retired = yield* createBot("Retired");
      const duplicate = yield* createBot("Duplicate");
      yield* members.setHidden({ botId: hidden.botId, hidden: true }, owner);
      yield* members.remove({ botId: retired.botId }, owner);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_runtime_state SET value_json = json_set(value_json, '$.name', 'SCOUT')
        WHERE json_extract(value_json, '$.botId') = ${duplicate.botId} AND key LIKE 'bot-profile:%'`;
      yield* connect(sdk);
      yield* linkAlice(sdk);
      for (const [index, name] of ["Missing", "Hidden", "Retired", "Scout"].entries()) {
        const root = "1760000003.00010" + index;
        const rejected = yield* receive(
          sdk,
          channelMention({ text: "<@U0BOT> " + name + ": do: check the build", ts: root }),
          "EvRouteDenied" + index,
        );
        assert.strictEqual(rejected?.snapshot.state, "rejected");
        assert.isFalse(sdk.posted.some((post) => post.threadTs === root));
        assert.lengthOf(sdk.ephemeral, index + 1);
        const notice = sdk.ephemeral[index];
        assert.strictEqual(notice?.channel, "C0ALLOWED");
        assert.isUndefined(notice?.threadTs);
        assert.strictEqual(notice?.userId, "U0ALICE");
        assert.include(notice?.text ?? "", "Reachable bots");
        for (const unavailable of ["Hidden", "Retired", "Scout"])
          assert.notInclude(notice?.text ?? "", unavailable);
      }
      assert.lengthOf((yield* tasks).tasks, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("routes Link as a name while the link code still works", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const link = yield* createBot("Link");
      yield* connect(sdk);
      yield* linkAlice(sdk);
      const routed = yield* receive(
        sdk,
        directMessage({ text: "Link: check the build" }),
        "EvNamedLink",
      );
      assert.strictEqual(routed?.botId, link.botId);
      assert.strictEqual(routed?.message.text, "check the build");
    }).pipe(Effect.provide(layer));
  });

  it.effect("pins the longest matching name and consumes its complete prefix", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* createBot("Ops");
      const east = yield* createBot("Ops: East");
      yield* connect(sdk);
      yield* linkAlice(sdk);
      const routed = yield* receive(
        sdk,
        channelMention({ text: "<@U0BOT> oPS: eAST: Check the build" }),
        "EvLongestName",
      );
      assert.strictEqual(routed?.botId, east.botId);
      assert.strictEqual(routed?.message.text, "Check the build");
      const followup = yield* receive(
        sdk,
        channelMention({
          text: "<@U0BOT> Check the logs",
          ts: "1760000000.000101",
          thread_ts: ROOT_TS,
        }),
        "EvLongestNameFollowup",
      );
      assert.strictEqual(followup?.botId, east.botId);
    }).pipe(Effect.provide(layer));
  });

  it.effect("routes Link Scout by name after linking Alice with a real code", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const scout = yield* createBot("Link Scout");
      yield* connect(sdk);
      yield* linkAlice(sdk);
      const routed = yield* receive(
        sdk,
        directMessage({ text: "Link Scout: Check the build" }),
        "EvNamedLinkScout",
      );
      assert.strictEqual(routed?.botId, scout.botId);
      assert.strictEqual(routed?.message.text, "Check the build");
      assert.strictEqual(routed?.snapshot.state, "replied");
    }).pipe(Effect.provide(layer));
  });

  it.effect("privately refuses an unmatched Do prefix", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* connect(sdk);
      yield* linkAlice(sdk);
      const rejected = yield* receive(
        sdk,
        channelMention({ text: "<@U0BOT> Do: check the build" }),
        "EvNamedDo",
      );
      assert.strictEqual(rejected?.snapshot.state, "rejected");
      assert.strictEqual(sdk.ephemeral.at(-1)?.userId, "U0ALICE");
      assert.lengthOf((yield* tasks).tasks, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "keeps notes out of the provider's default session for a Slack sender without memory access",
    () =>
      Effect.gen(function* () {
        const provider = yield* nextTurnSelectionHarness("slack-default-notes");
        const { sdk, layer } = slackScenario({
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
          const scout = yield* createBot("Scout");
          const fs = yield* FileSystem.FileSystem;
          const files = channelBotFilesFor(
            yield* Path.Path,
            (yield* ServerConfig.ServerConfig).stateDir,
          );
          yield* fs.makeDirectory(files.dir, { recursive: true });
          const question = "What is the deploy phrase?";
          yield* fs.writeFileString(
            files.notes,
            [
              "- 2026-02-01: The deploy phrase is cobalt. (asked in x)",
              ...Array.from(
                { length: 40 },
                (_, index) =>
                  "- 2026-02-10: " + ("Checklist " + index + ". ").repeat(20) + "(asked in x)",
              ),
              "- 2026-03-01: Check with the on-call engineer named Indigo. (asked in y)",
            ].join("\n") + "\n",
          );
          const notes = yield* readChannelBotNotesSnapshot(files, question);
          assert.include(notes?.matched ?? "", "cobalt");
          assert.include(notes?.standing ?? "", "Indigo");
          yield* connect(sdk, {
            botBindings: [{ channelId: "C0ALLOWED", botId: scout.botId }],
          });
          yield* linkAlice(sdk);
          const input = yield* receive(
            sdk,
            channelMention({ text: "<@U0BOT> " + question }),
            "EvDefaultNotes",
          );
          const [task] = (yield* tasks).tasks;
          assert.strictEqual(input?.botId, scout.botId);
          assert.strictEqual(task?.kind, "turn");
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          assert.lengthOf(provider.started, 1);
          const text = provider.started[0]?.message.text ?? "";
          assert.include(text, question);
          assert.notInclude(text, "cobalt");
          assert.notInclude(text, "Indigo");
          assert.notInclude(text, files.notes);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("refuses a queued Slack turn when its sender loses the memory grant", () =>
    Effect.gen(function* () {
      const provider = yield* nextTurnSelectionHarness("slack-queued-notes");
      const { sdk, layer } = slackScenario({
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
        const fs = yield* FileSystem.FileSystem;
        const files = channelBotFilesFor(
          yield* Path.Path,
          (yield* ServerConfig.ServerConfig).stateDir,
        );
        yield* fs.makeDirectory(files.dir, { recursive: true });
        yield* fs.writeFileString(
          files.notes,
          "- 2026-02-01: The deploy phrase is cobalt. (asked in x)\n",
        );
        const memoryOwner: typeof owner = {
          ...owner,
          grantedScopes: [...owner.grantedScopes, "memory:read"],
        };
        yield* connect(sdk, { owner: memoryOwner });
        yield* linkAlice(sdk, memoryOwner);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        yield* receive(
          sdk,
          channelMention({ text: "<@U0BOT> Check the deployment" }),
          "EvBusySession",
        );
        yield* worker.drain();
        const [first] = provider.started;
        assert(first !== undefined);
        assert.include(first.message.text, "cobalt");
        yield* TestClock.adjust("55 seconds");
        yield* (yield* ChannelRuntime.ChannelRuntime).expireOverdue;
        const request = yield* receive(
          sdk,
          channelMention({
            text: "<@U0BOT> Check the deploy phrase",
            ts: "1760000000.000101",
            thread_ts: ROOT_TS,
          }),
          "EvQueuedNotes",
        );
        const task = (yield* tasks).tasks.find(
          (task) => task.originInputId === request?.snapshot.inputId,
        );
        assert(task?.worker?.runId !== undefined);
        const { threadId, runId } = task.worker;
        const ledger = yield* ChannelLedger.ChannelLedger;
        assert.strictEqual(
          (yield* ledger.latestTaskBrief(task.taskId))?.context.notesPath,
          files.notes,
        );
        const queued = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
          (run) => run.id === runId,
        );
        assert.strictEqual(queued?.status, "queued");
        assert.lengthOf(provider.started, 1);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_identities SET granted_scopes_json = '["orchestration:operate"]'
          WHERE connection_id = ${connectionId} AND external_actor_id = 'U0ALICE'`;
        const afterSequence = yield* eventSink.latestSequence({ threadId });
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
        yield* eventSink.stream({ threadId, afterSequence, eventType: "run.updated" }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.updated" &&
              event.payload.id === runId &&
              event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* worker.drain();
        assert.lengthOf(provider.started, 1);
        const stopped = yield* orchestrator.getThreadRecords(threadId, ["runs", "turnItems"], {
          turnItemRunIds: [runId],
        });
        assert.strictEqual(stopped.runs.find((run) => run.id === runId)?.status, "failed");
        assert.isTrue(
          stopped.turnItems.some(
            (item) => item.type === "error" && item.failure.code === "permission_changed",
          ),
        );
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.status, "failed");
        const failures = yield* sql<{ readonly reason: string }>`
          SELECT json_extract(event_json, '$.payload.reason') AS reason FROM channel_task_events
          WHERE task_id = ${task.taskId} AND type = 'task.failed'
        `;
        assert.deepStrictEqual(
          failures.map(({ reason }) => reason),
          ["permission_changed"],
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("omits the notes file from the local worker brief without memory access", () => {
    const { sdk, harness, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* createBot("Scout");
      yield* connect(sdk);
      yield* linkAlice(sdk);
      const input = yield* receive(
        sdk,
        channelMention({ text: "<@U0BOT> Scout: do: check the build" }),
        "EvWorkerNotes",
      );
      const [task] = (yield* tasks).tasks;
      assert(task !== undefined);
      assert.strictEqual(task.originInputId, input?.snapshot.inputId);
      const files = channelBotFilesFor(
        yield* Path.Path,
        (yield* ServerConfig.ServerConfig).stateDir,
      );
      const text =
        harness.world.launches.find((launch) => launch.initialMessage !== undefined)?.initialMessage
          ?.text ?? "";
      assert.include(text, "check the build");
      assert.notInclude(text, files.notes);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists and opens a default Slack turn from its assigned member's Home", () => {
    const { sdk, layer } = slackScenario({ botWorkspace: true });
    return Effect.gen(function* () {
      yield* setupBot;
      const scout = yield* createBot("Scout");
      const other = yield* createBot("Builder");
      yield* connect(sdk, { botBindings: [{ channelId: "C0ALLOWED", botId: scout.botId }] });
      yield* linkAlice(sdk);
      const input = yield* receive(
        sdk,
        channelMention({ text: "<@U0BOT> Check the build" }),
        "EvDefaultHome",
      );
      const [task] = (yield* tasks).tasks;
      assert(task !== undefined);
      assert.strictEqual(task.kind, "turn");
      assert.strictEqual(task.originInputId, input?.snapshot.inputId);
      const home = yield* ChannelBotThreads.ChannelBotThreads;
      const taskIds = (rows: (typeof current)["rows"]) =>
        rows.flatMap((row) => (row.kind === "task" ? [row.task.taskId] : []));
      const current = yield* home.list(owner, scout.botId);
      assert.deepStrictEqual(taskIds(current.rows), [task.taskId]);
      const history = yield* home.list(owner, scout.botId, {});
      assert.deepStrictEqual(taskIds(history.rows), [task.taskId]);
      const search = yield* home.searchBotTasks(
        { botId: scout.botId, query: "Check the build" },
        owner,
      );
      assert.deepStrictEqual(
        search.tasks.map((row) => row.taskId),
        [task.taskId],
      );
      const detail = yield* home.getBotTask({ botId: scout.botId, taskId: task.taskId }, owner);
      assert.strictEqual(detail.task.state, "known");
      if (detail.task.state === "known")
        assert.strictEqual(detail.task.row.task.taskId, task.taskId);
      assert.isEmpty((yield* home.list(owner, other.botId)).rows);
      assert.strictEqual(
        (yield* Effect.flip(home.getBotTask({ botId: other.botId, taskId: task.taskId }, owner)))
          .reason,
        "not_found",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to restore a deleted bot whose name is in use", () => {
    const { layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const deleted = yield* createBot("Scout");
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      yield* members.remove({ botId: deleted.botId }, owner);
      const current = yield* createBot("SCOUT");
      const error = yield* Effect.flip(members.restore({ botId: deleted.botId }, owner));
      assert.strictEqual(error.reason, "invalid_input");
      assert.include(error.message, current.name);
      yield* members.update({ botId: current.botId, name: "Navigator" }, owner);
      const restored = yield* members.restore({ botId: deleted.botId }, owner);
      assert.strictEqual(restored.state, "active");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a deleted bot's Slack thread private and starts no replacement work", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const scout = yield* createBot("Scout");
      yield* connect(sdk, { botBindings: [{ channelId: "C0ALLOWED", botId: scout.botId }] });
      yield* linkAlice(sdk);
      yield* receive(sdk, channelMention(), "EvDeletedFirst");
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      yield* members.remove({ botId: scout.botId }, owner);
      const publicCount = sdk.posted.length;
      const rejected = yield* receive(
        sdk,
        channelMention({
          text: "<@U0BOT> do: check the build",
          ts: "1760000004.000100",
          thread_ts: ROOT_TS,
        }),
        "EvDeletedReply",
      );
      assert.strictEqual(rejected?.snapshot.state, "rejected");
      assert.lengthOf(sdk.posted, publicCount);
      assert.strictEqual(sdk.ephemeral.length, 1);
      assert.strictEqual(sdk.ephemeral[0]?.userId, "U0ALICE");
      assert.include(sdk.ephemeral[0]?.text ?? "", "Scout was deleted");
      assert.lengthOf((yield* tasks).tasks, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "routes an unlinked workspace sender to a member without supplying shared notes",
    () => {
      const { sdk, harness, layer } = slackScenario();
      const seen: Array<ChannelReceptionInput> = [];
      harness.script.current = (input) => {
        seen.push(input);
        return defaultScript(input);
      };
      return Effect.gen(function* () {
        yield* setupBot;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ goatBotSessionRouting: "reception" });
        const files = channelBotFilesFor(
          yield* Path.Path,
          (yield* ServerConfig.ServerConfig).stateDir,
        );
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(files.dir, { recursive: true });
        yield* fs.writeFileString(
          files.notes,
          "- 2026-03-01: The deploy secret is cobalt. (asked in channel-input:note)\n",
        );
        const scout = yield* createBot("Scout");
        yield* connect(sdk, {
          botBindings: [{ channelId: "C0ALLOWED", botId: scout.botId }],
          unlinkedRuntimeModeCeiling: "approval-required",
        });
        const result = yield* receive(
          sdk,
          channelMention({ text: "<@U0BOT> What is the deploy secret?" }),
          "EvNamedUnlinked",
        );
        const reception = seen.find((entry) => entry.inputText === "What is the deploy secret?");
        assert.isDefined(reception);
        assert.isUndefined(reception?.notes);
        assert.strictEqual(result?.botId, scout.botId);
        assert.strictEqual(reception?.identity?.name, "Scout");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps a binding through an older settings save and rejects invalid bindings", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const scout = yield* createBot("Scout");
      const settings = yield* SlackChannelSettings.SlackChannelSettings;
      const binding = { channelId: "C0ALLOWED", botId: scout.botId };
      const saved = yield* settings.configure(
        {
          enabled: true,
          appToken: "xapp-1-test",
          botToken: "xoxb-test",
          botBindings: [binding],
          allowedChannelIds: [binding.channelId],
          userAccess: "linked",
        },
        owner,
      );
      assert.deepStrictEqual(saved.botBindings, [binding]);
      const updated = yield* settings.configure(
        { connectionId: saved.connectionId, enabled: true },
        owner,
      );
      assert.deepStrictEqual(updated.botBindings, [binding]);
      for (const botBindings of [
        [binding, binding],
        [{ ...binding, botId: BotId.make("other-owner") }],
      ]) {
        const failure = yield* Effect.flip(
          settings.configure(
            {
              connectionId: saved.connectionId,
              enabled: true,
              botBindings,
            },
            owner,
          ),
        );
        assert.strictEqual(failure.reason, "invalid_input");
      }
      const runtime = yield* SlackChannelRuntime.SlackChannelRuntime;
      yield* runtime.streamStatus.pipe(
        Stream.filter(
          (event) => event.connectionId === saved.connectionId && event.status === "connected",
        ),
        Stream.runHead,
      );
      yield* receive(sdk, channelMention({ text: "<@U0BOT> Scout: hello" }), "EvUnlinkedBound");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const rejected = yield* ledger.getInput(
        inputIdFor({
          ownerId,
          kind: "slack",
          connectionId: saved.connectionId,
          idempotencyKey: "T0TEAM:EvUnlinkedBound",
        }),
      );
      assert.strictEqual(rejected?.snapshot.state, "rejected");
      assert.isEmpty(sdk.ephemeral);
      assert.include(sdk.posted[0]?.text ?? "", CHANNEL_COPY.unlinkedInput.slice(0, 20));
      const cleared = yield* settings.configure(
        {
          connectionId: saved.connectionId,
          enabled: true,
          botBindings: [],
        },
        owner,
      );
      assert.deepStrictEqual(cleared.botBindings, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses the member's sender name when Slack grants customization", () => {
    const { sdk, layer } = slackScenario();
    sdk.script.authTest = () =>
      Promise.resolve({
        teamId: "T0TEAM",
        botUserId: "U0BOT",
        botId: "B0BOT",
        customizeReplies: true,
      });
    return Effect.gen(function* () {
      yield* setupBot;
      const scout = yield* createBot("Scout");
      const builder = yield* createBot("Builder");
      yield* connect(sdk, { botBindings: [{ channelId: "C0ALLOWED", botId: builder.botId }] });
      yield* linkAlice(sdk);
      const routed = yield* receive(
        sdk,
        channelMention({ text: "<@U0BOT> Scout: do: check the build" }),
        "EvCustomize",
      );
      assert.strictEqual(routed?.botId, scout.botId);
      const post = sdk.posted.find((entry) => entry.threadTs === ROOT_TS);
      assert.strictEqual(post?.username, "Scout");
      assert.match(post?.iconUrl ?? "", /^https:\/\//u);
      assert.notInclude(post?.text ?? "", "Scout:");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stores one input and one task for an event Slack sends twice", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* connect(sdk);
      yield* linkAlice(sdk);
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* runtime.drain;
      const mention = channelMention({
        text: "<@U0BOT> GOAT Bot: do: fix the login bug",
        ts: ROOT_TS,
      });
      const first = yield* emit(sdk, mention, "EvMention0001");
      const retry = yield* emit(sdk, mention, "EvMention0001");
      assert.equal(first.ackCount() + retry.ackCount(), 2);
      yield* runtime.drain;
      // Both deliveries map to one stored input, which started the one task.
      const ledger = yield* ChannelLedger.ChannelLedger;
      const inputId = inputIdFor({
        ownerId,
        kind: "slack",
        connectionId,
        idempotencyKey: "T0TEAM:EvMention0001",
      });
      assert.isDefined(yield* ledger.getInput(inputId));
      const page = yield* tasks;
      assert.equal(page.tasks.length, 1);
      assert.equal(page.tasks[0]?.originInputId, inputId);
      // The receipt goes to the thread root and tags the requester.
      const receipts = sdk.posted.filter((post) => post.threadTs === ROOT_TS);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.channel, "C0ALLOWED");
      assert(receipts[0]?.text.startsWith("<@U0ALICE>"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers an unlinked user with the link notice and starts no work", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* connect(sdk);
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const envelope = yield* emit(
        sdk,
        channelMention({ text: "<@U0BOT> do: delete everything", ts: ROOT_TS }),
        "EvUnlinked001",
      );
      assert.equal(envelope.ackCount(), 1);
      yield* runtime.drain;
      assert.equal((yield* tasks).tasks.length, 0);
      const notices = sdk.posted.filter((post) => post.threadTs === ROOT_TS);
      assert.equal(notices.length, 1);
      assert(notices[0]?.text.includes(CHANNEL_COPY.unlinkedInput.slice(0, 20)));
    }).pipe(Effect.provide(layer));
  });

  it.effect("waits out Retry-After and never repeats a send that may have arrived", () => {
    const { sdk, layer } = slackScenario();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* connect(sdk);
      yield* linkAlice(sdk);
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* runtime.drain;
      const before = sdk.posted.length;

      sdk.script.postMessage = () =>
        Promise.reject(sdk.failure("chat.postMessage", "rate_limited", 30));
      yield* emit(sdk, channelMention({ text: "<@U0BOT> status?", ts: ROOT_TS }), "EvRate000001");
      yield* runtime.drain;
      assert.equal(sdk.posted.length, before + 1);
      sdk.script.postMessage = () => Promise.resolve({ ts: "1760000009.000100" });
      yield* TestClock.adjust(Duration.seconds(29));
      yield* runtime.drain;
      assert.equal(sdk.posted.length, before + 1, "retried before Retry-After");
      yield* TestClock.adjust(Duration.seconds(1));
      yield* runtime.drain;
      assert.equal(sdk.posted.length, before + 2);

      const otherRoot = "1760000000.000300";
      sdk.script.postMessage = () => Promise.reject(sdk.failure("chat.postMessage", "timeout"));
      yield* emit(sdk, channelMention({ text: "<@U0BOT> status?", ts: otherRoot }), "EvTimeout001");
      yield* runtime.drain;
      sdk.script.postMessage = () => Promise.resolve({ ts: "1760000009.000200" });
      yield* TestClock.adjust(Duration.minutes(30));
      yield* runtime.drain;
      assert.equal(sdk.posted.filter((post) => post.threadTs === otherRoot).length, 1);
    }).pipe(Effect.provide(layer));
  });
});
