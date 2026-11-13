import { assert, describe, it } from "@effect/vitest";
import type { RuntimeMode } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../serverSettings.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";
import { RemoteMachine, correlationOf, remoteScript, until } from "./testing/RemoteMachine.ts";

const pinnedHarness = () => {
  const machine = new RemoteMachine();
  const harness = makeHarness({ sshRemote: machine.layer });
  harness.script.current = remoteScript;
  return { machine, harness };
};

const automaticHarness = () => {
  const machine = new RemoteMachine();
  machine.offeredModels = [{ instance: "codex", model: "gpt-6.1-sol" }];
  machine.hostQuotas = { codex: 20 };
  const harness = makeHarness({
    sshRemote: machine.layer,
    projects: 1,
    repositoryIdentity: {
      canonicalKey: "github.com/goat-si/goat",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/goat-si/goat.git",
      },
    },
    settingsLayer: ServerSettings.layerTest({
      channelAutoPlacement: true,
      textGenerationModelSelection: modelSelection,
    }).pipe(Layer.orDie),
    providerInstances: [{ instanceId: "codex", displayName: "Local Codex", weeklyUsedPercent: 80 }],
  });
  harness.script.current = remoteScript;
  return { machine, harness };
};

/** Changes the Slack requester's ceiling in place, as editing their link in GOAT does. */
export const setRequesterCeiling = (ceiling: RuntimeMode) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) =>
        sql`UPDATE channel_identities SET runtime_mode_ceiling = ${ceiling} WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`,
    ),
  );

/** A Slack requester's task on the remote machine, waiting on the question its worker asked. */
export const askedOnRemote = (machine: RemoteMachine, request: string, key: string) =>
  Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    yield* gateway.ingest(slackInput(request, key + "-1"), slackContext);
    yield* until("running", (task) => task.status === "running");
    const correlationId = correlationOf(machine);
    machine.report(correlationId, "needs_input", "Which one?");
    machine.finishRun(correlationId, "completed", "Asked.");
    yield* until("question", (task) => task.status === "waiting_input");
    return correlationId;
  });

export const answer = (key: string) =>
  ChannelGateway.ChannelGateway.pipe(
    Effect.flatMap((gateway) =>
      gateway.ingest(slackInput("answer: the first", key + "-answer"), slackContext),
    ),
  );

const sendCeilings = (machine: RemoteMachine) =>
  machine.calls.filter((call) => call.tool === "goat_thread_send").map((call) => call.ceiling);

describe("remote answers and the requester's current ceiling", () => {
  const placements = [
    ["pinned", pinnedHarness, "do@mac-studio: ask me"],
    ["automatic", automaticHarness, "do: ask me"],
  ] as const;

  it.effect.each(placements)(
    "authority: a %s remote answer goes out under the ceiling the requester still holds",
    ([placement, makeRemote, request]) => {
      const { machine, harness } = makeRemote();
      return Effect.gen(function* () {
        yield* askedOnRemote(machine, request, placement + "-allowed");
        yield* answer(placement + "-allowed");
        yield* until("answer sent", () => machine.sends.length === 1);
        assert.deepStrictEqual(sendCeilings(machine), ["auto-accept-edits"]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each(placements)(
    "authority: a %s remote task's requester whose ceiling fell below it cannot answer it",
    ([placement, makeRemote, request]) => {
      const { machine, harness } = makeRemote();
      return Effect.gen(function* () {
        yield* askedOnRemote(machine, request, placement + "-lowered");
        yield* setRequesterCeiling("approval-required");
        yield* answer(placement + "-lowered");
        // Reception has decided once the runtime drains; the answer was never accepted.
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        const sql = yield* SqlClient.SqlClient;
        const answered =
          yield* sql`SELECT 1 FROM channel_task_events WHERE type = 'task.question.answered'`;
        assert.lengthOf(answered, 0);
        const task = yield* onlyTask;
        assert.strictEqual(task.status, "waiting_input");
        assert.lengthOf(task.openQuestions, 1);
        assert.lengthOf(machine.sends, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each(placements)(
    "authority: an accepted %s remote answer is never sent once the requester's ceiling falls during the send",
    ([placement, makeRemote, request]) => {
      const { machine, harness } = makeRemote();
      return Effect.gen(function* () {
        yield* askedOnRemote(machine, request, placement + "-during");
        const lower = setRequesterCeiling("approval-required").pipe(
          Effect.provideService(SqlClient.SqlClient, yield* SqlClient.SqlClient),
          Effect.orDie,
          Effect.asVoid,
        );
        const sendDenied = yield* Deferred.make<void>();
        machine.beforeHostCall = (call) =>
          call.tool === "goat_thread_send"
            ? Effect.suspend(() => {
                machine.beforeHostCall = undefined;
                return lower;
              })
            : Effect.void;
        machine.onAuthorizationDenied = (call) =>
          call.tool === "goat_thread_send"
            ? Deferred.succeed(sendDenied, undefined).pipe(Effect.asVoid)
            : Effect.void;
        yield* answer(placement + "-during");
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        // That send's second authorization was refused, so nothing reached the host.
        yield* Deferred.await(sendDenied);
        assert.deepStrictEqual(sendCeilings(machine), []);
        assert.lengthOf(machine.sends, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
