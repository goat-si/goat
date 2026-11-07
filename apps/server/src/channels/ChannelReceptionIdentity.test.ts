import { assert, describe, it } from "@effect/vitest";
import { BotId, type ChannelReceptionInput } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as ChannelBotProfiles from "./ChannelBotProfiles.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  onlyTask,
  owner,
  ownerId,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const jarvis = { name: "Jarvis", purpose: "Watch the deploys." };
const rename = ChannelBotProfiles.ChannelBotProfiles.pipe(
  Effect.flatMap((profiles) => profiles.update({ botId: BotId.make("main"), ...jarvis }, owner)),
);
const receptionFirst = ServerSettings.ServerSettingsService.pipe(
  Effect.flatMap((settings) => settings.updateSettings({ goatBotSessionRouting: "reception" })),
);
const mainKey = "bot-profile:" + encodeURIComponent(ownerId) + ":main";
const corruptProfile = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) =>
      sql`UPDATE channel_runtime_state SET value_json = ${"bad json"} WHERE key = ${mainKey}`,
  ),
);
const finishOnlyTask = (harness: ReturnType<typeof makeHarness>, summary: string) =>
  Effect.gen(function* () {
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    const task = yield* onlyTask;
    harness.world.setStatus(task.worker!.threadId, 1, "completed", summary);
    yield* reports.reconcile(runtime.ownerToken);
    yield* runtime.drain;
  });

describe("GOAT Bot reception and the bot's profile", () => {
  it.effect("tells every reception pass of a renamed bot its name and purpose", () => {
    const harness = makeHarness();
    const seen: Array<ChannelReceptionInput> = [];
    harness.script.current = (input) => {
      seen.push(input);
      if (input.mode === "input" && input.inputText === "who are you?")
        return Effect.succeed(
          input.readsAllowed === true
            ? {
                replyText: "",
                action: { type: "read", reads: [{ kind: "memory", query: "deploys" }] },
              }
            : { replyText: "I'm Jarvis.", action: { type: "report_only" } },
        );
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      yield* receptionFirst;
      yield* rename;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("who are you?", "r1"), rpcContext);
      yield* runtime.drain;
      yield* linkSlackUser();
      yield* gateway.ingest(slackInput("do: fix the build", "r2"), slackContext);
      yield* runtime.drain;
      yield* finishOnlyTask(harness, "The build passes again.");
      const modes = seen.map((input) => input.mode + ":" + String(input.readsAllowed));
      assert.deepStrictEqual(modes, [
        "input:true",
        "input:false",
        "input:true",
        "task_event:undefined",
      ]);
      for (const input of seen) assert.deepStrictEqual(input.identity, jarvis);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps one identity for both passes of a message renamed in between", () => {
    const harness = makeHarness();
    const seen: Array<ChannelReceptionInput> = [];
    return Effect.gen(function* () {
      yield* setupBot;
      yield* receptionFirst;
      yield* rename;
      const profiles = yield* ChannelBotProfiles.ChannelBotProfiles;
      const renameAgain = profiles
        .update({ botId: BotId.make("main"), name: "Friday" }, owner)
        .pipe(Effect.orDie);
      harness.script.current = (input) => {
        seen.push(input);
        if (input.mode !== "input") return defaultScript(input);
        // The rename lands while the first pass is still deciding.
        return input.readsAllowed === true
          ? Effect.as(renameAgain, {
              replyText: "",
              action: { type: "read" as const, reads: [{ kind: "memory" as const, query: "x" }] },
            })
          : Effect.succeed({ replyText: "Hi.", action: { type: "report_only" as const } });
      };
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("who are you?", "s1"), rpcContext);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("and now?", "s2"), rpcContext);
      yield* runtime.drain;
      assert.deepStrictEqual(
        seen.map((input) => input.identity?.name),
        ["Jarvis", "Jarvis", "Friday", "Friday"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("acknowledges a silent session request as the renamed bot", () => {
    const harness = makeHarness({ botWorkspace: true });
    const seen: Array<ChannelReceptionInput> = [];
    harness.script.current = (input) => {
      seen.push(input);
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      yield* rename;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const input = yield* gateway.ingest(goatInput("Inspect this machine", "a1"), rpcContext);
      yield* runtime.drain;
      yield* TestClock.adjust("20 seconds");
      yield* runtime.expireOverdue;
      yield* runtime.settle([input.inputId]);
      assert.deepStrictEqual(
        seen.map((entry) => [entry.mode, entry.identity]),
        [["task_event", jarvis]],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "answers a message with a failure, never a stale name, when the profile is unreadable",
    () => {
      const harness = makeHarness();
      const seen: Array<ChannelReceptionInput> = [];
      harness.script.current = (input) => {
        seen.push(input);
        return defaultScript(input);
      };
      return Effect.gen(function* () {
        yield* setupBot;
        yield* receptionFirst;
        yield* rename;
        yield* corruptProfile;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const sent = yield* gateway.ingest(goatInput("hello", "u1"), rpcContext);
        yield* runtime.drain;
        assert.deepStrictEqual(seen, []);
        const stored = yield* ledger.getInput(sent.inputId);
        assert.strictEqual(stored?.snapshot.failure?.reason, "reception_failed");
        const texts = (yield* botMessages).messages.map((message) => message.text);
        assert.isTrue(texts.some((text) => text.includes("name and purpose could not be read")));
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("passes a finished task's own words on when the profile turns unreadable", () => {
    const harness = makeHarness();
    const seen: Array<ChannelReceptionInput> = [];
    harness.script.current = (input) => {
      seen.push(input);
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      yield* receptionFirst;
      yield* rename;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* linkSlackUser();
      yield* gateway.ingest(slackInput("do: fix the build", "n1"), slackContext);
      yield* runtime.drain;
      yield* corruptProfile;
      yield* finishOnlyTask(harness, "The build passes again.");
      assert.isFalse(seen.some((input) => input.mode === "task_event"));
      const texts = harness.slackSent.map((sent) => sent.message.text);
      assert.isTrue(texts.some((text) => text.includes("The build passes again.")));
    }).pipe(Effect.provide(harness.layer));
  });
});
