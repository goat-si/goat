import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ChannelBotMembers } from "./ChannelBotMembers.ts";
import { ChannelGateway } from "./ChannelGateway.ts";
import { ChannelLedger } from "./ChannelLedger.ts";
import { ChannelRuntime } from "./ChannelRuntime.ts";
import { withWebhookService } from "../scheduledTasks/ScheduledRunFixture.testkit.ts";
import {
  linkSlackUser,
  makeHarness,
  owner,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const signature = { header: "x-example-signature", encoding: "hex", prefix: "sha256=" } as const;
const sample = {
  version: 1,
  name: "Build Scout",
  face: "🔎",
  color: "#286470",
  purpose: "Review builds.",
  instructions: "Summarize failures.",
  automations: [
    {
      title: "Build check",
      prompt: "Review the build.",
      schedule: { type: "interval", everyMs: 60_000 },
    },
    {
      title: "Pull request trigger",
      prompt: "Review the change.",
      schedule: { type: "webhook", signature },
    },
  ],
  tools: { mcpServers: ["deploy"], skills: ["review"] },
};

const capture = Effect.succeed({
  memoryGrantCeiling: "none" as const,
  owner: {
    principalId: owner.principalId,
    grantedScopes: owner.grantedScopes,
    sessionId: "package-owner-session",
  },
});

it.effect("blocks export of bot instructions containing a token-shaped string", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const members = yield* ChannelBotMembers;
    const bot = yield* members.create(
      {
        name: "Build Scout",
        avatar: null,
        purpose: "Review builds.",
        defaultModelSelection: null,
        clientRequestId: "create-for-export",
      },
      owner,
    );
    yield* members.update({ botId: bot.botId, instructions: "Use ghp_" + "a".repeat(36) }, owner);
    assert.deepStrictEqual(yield* members.exportPackage({ botId: bot.botId }, owner), {
      status: "blocked",
      fields: ["/instructions"],
    });
    yield* members.update({ botId: bot.botId, instructions: "Use the build dashboard." }, owner);
    const exported = yield* members.exportPackage({ botId: bot.botId }, owner);
    assert.strictEqual(exported.status, "ready");
    if (exported.status === "ready") {
      assert.strictEqual(JSON.parse(exported.contents).instructions, "Use the build dashboard.");
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("binds confirmation to the reviewed package and resumes paused automations once", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const members = yield* ChannelBotMembers;
    const sql = yield* SqlClient.SqlClient;
    yield* withWebhookService(
      ({ service }) =>
        Effect.gen(function* () {
          const text = JSON.stringify(sample);
          const context = { service, capture };
          const { digest } = yield* members.reviewPackage({ text });
          const input = { text, digest, clientRequestId: "import-1" };
          const changed = yield* members
            .importPackage({ ...input, text: text + " " }, owner, context)
            .pipe(Effect.flip);
          assert.strictEqual(changed.reason, "invalid_input");
          const withoutPerson = yield* members
            .importPackage(input, owner, {
              service,
              capture: Effect.succeed({ memoryGrantCeiling: "none" }),
            })
            .pipe(Effect.flip);
          assert.strictEqual(withoutPerson.reason, "forbidden");

          yield* sql`CREATE TEMP TRIGGER fail_bot_import BEFORE INSERT ON scheduled_tasks
            WHEN NEW.title = 'Pull request trigger'
            BEGIN SELECT RAISE(ABORT, 'fixture: scheduling unavailable'); END`;
          yield* members.importPackage(input, owner, context).pipe(Effect.flip);
          const partial = (yield* members.list({}, owner)).find((bot) => bot.name === sample.name);
          assert.isDefined(partial);
          yield* sql`DROP TRIGGER fail_bot_import`;

          const result = yield* members.importPackage(input, owner, context);
          assert.strictEqual(result.bot.botId, partial?.botId);
          assert.strictEqual(
            (yield* members.importPackage(input, owner, context)).bot.botId,
            result.bot.botId,
          );
          assert.deepStrictEqual(result.bot.tools, { mcpServers: [], skills: [] });
          assert.deepStrictEqual(result.bot.importedToolNames, sample.tools);
          const { tasks } = yield* service.list();
          assert.lengthOf(tasks, 2);
          assert.isTrue(
            tasks.every((task) => !task.enabled && task.threadId === result.bot.sessionThreadId),
          );
          const trigger = tasks.find((task) => task.schedule.type === "webhook");
          assert.isDefined(trigger);
          if (trigger === undefined || trigger.schedule.type !== "webhook") return;
          assert.deepStrictEqual(trigger.schedule.signature, {
            ...signature,
            required: true,
            secretSet: false,
          });
          const grant = yield* capture;
          const save = {
            ...trigger,
            requireExisting: true,
            enabled: true,
            schedule: { type: "webhook", signature },
          } as const;
          for (const attempt of [
            service.setEnabled({ id: trigger.id, enabled: true }, grant),
            service.upsert(save, grant),
          ]) {
            assert.include((yield* Effect.flip(attempt)).message, "signing secret");
          }
          const saved = yield* service.upsert(
            {
              ...save,
              enabled: false,
              schedule: {
                type: "webhook",
                signature: { ...signature, secret: "fixture-local-signing-secret" },
              },
            },
            grant,
          );
          assert.isTrue(saved.task.webhook?.hasSecret);
          assert.isTrue(
            (yield* service.setEnabled({ id: trigger.id, enabled: true }, grant)).task.enabled,
          );
          const exported = yield* members.exportPackage({ botId: result.bot.botId }, owner);
          assert.strictEqual(exported.status, "ready");
          if (exported.status === "ready") {
            assert.notInclude(exported.contents, "fixture-local-signing-secret");
            assert.notInclude(exported.contents, "/api/hooks");
            assert.deepStrictEqual(
              JSON.parse(exported.contents).automations[1].schedule.signature,
              signature,
            );
          }
        }),
      { sql },
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses a restricted imported bot's local worker at dispatch", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const members = yield* ChannelBotMembers;
    const sql = yield* SqlClient.SqlClient;
    yield* withWebhookService(
      ({ service }) =>
        Effect.gen(function* () {
          const text = JSON.stringify({ ...sample, automations: [] });
          const { digest } = yield* members.reviewPackage({ text });
          const { bot } = yield* members.importPackage(
            { text, digest, clientRequestId: "import-local-worker" },
            owner,
            { service, capture },
          );
          const ledger = yield* ChannelLedger;
          const gateway = yield* ChannelGateway;
          const runtime = yield* ChannelRuntime;
          yield* gateway.ingest(
            slackInput("Build Scout: do: use the deploy tool", "local-denied"),
            slackContext,
          );
          yield* runtime.drain;
          const { tasks } = yield* ledger.listTasks({
            ownerId: owner.ownerId,
            botId: bot.botId,
            limit: 10,
          });
          assert.lengthOf(tasks, 1);
          assert.include(tasks[0]?.resultSummary ?? "", "tool limits can't be applied");
          assert.isUndefined(tasks[0]?.worker);
          const mapped = yield* members.update(
            { botId: bot.botId, tools: { mcpServers: ["deploy"], skills: [] } },
            owner,
          );
          assert.deepStrictEqual(mapped.tools, { mcpServers: ["deploy"], skills: [] });
        }),
      { sql },
    );
  }).pipe(Effect.provide(harness.layer));
});
