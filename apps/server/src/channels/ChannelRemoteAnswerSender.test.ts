import { assert, describe, it } from "@effect/vitest";
import type { AuthEnvironmentScope } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import {
  RemoteMachine,
  correlationOf,
  remoteScript,
  settle,
  until,
} from "./testing/RemoteMachine.ts";
import {
  makeHarness,
  owner,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

/** Answers to work on another machine from someone other than the requester, checked at delivery. */

const ROOT = "1760000000.000900";
const transport = {
  ...slackContext,
  grantedScopes: [...slackContext.grantedScopes, "memory:read", "memory:write"],
} satisfies typeof slackContext;
const WITHOUT_MEMORY: ReadonlyArray<AuthEnvironmentScope> = [
  "orchestration:read",
  "orchestration:operate",
];

const remoteHarness = () => {
  const machine = new RemoteMachine();
  const harness = makeHarness({ sshRemote: machine.layer });
  harness.script.current = remoteScript;
  return { machine, harness };
};

const link = (user: string, displayName: string) =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const { code } = yield* identities.createLink(
      {
        connectionId: "slack-1",
        runtimeModeCeiling: "full-access",
        grantedScopes: ["orchestration:read", "orchestration:operate", "memory:read"],
      },
      {
        ...owner,
        principalId: "principal-" + user,
        displayName,
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

const narrow = (user: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`UPDATE channel_identities SET granted_scopes_json = ${JSON.stringify(WITHOUT_MEMORY)} WHERE connection_id = 'slack-1' AND external_actor_id = ${user}`,
  );

const say = (user: string, text: string, key: string) =>
  Effect.flatMap(ChannelGateway.ChannelGateway, (gateway) =>
    gateway.ingest(slackInput(text, key, ROOT, user), transport),
  );

/** U2's task on mac-studio, waiting on a question; U1 is a colleague with the same memory. */
const askedOnMachine = (machine: RemoteMachine, colleagueName = "Colleague") =>
  Effect.gen(function* () {
    yield* setupBot;
    yield* link("U2", "Teammate");
    yield* link("U1", colleagueName);
    yield* say("U2", "do@mac-studio: pick a branch", "start");
    yield* until("running", (task) => task.status === "running");
    const correlationId = correlationOf(machine);
    machine.report(correlationId, "needs_input", "Which branch?");
    machine.finishRun(correlationId, "completed", "Waiting for an answer.");
    return yield* until("question", (task) => task.status === "waiting_input");
  });

const pendingForwards = Effect.flatMap(ChannelLedger.ChannelLedger, (ledger) =>
  ledger.listPendingForwards(10),
);

const sent = (machine: RemoteMachine, text: string) =>
  machine.sends.some((send) => (send.message as string).includes(text));

const reasked = (text: string) =>
  until("asked again", (task) =>
    task.openQuestions.some((question) => question.text.includes(text)),
  );

describe("an answer to work on another machine", () => {
  it.effect("is not sent once its sender lost access after it was accepted", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* askedOnMachine(machine);
      machine.down = true;
      yield* say("U1", "answer: use main", "answer");
      yield* settle();
      assert.lengthOf(machine.sends, 0);
      yield* narrow("U1");
      machine.down = false;
      const task = yield* reasked("Colleague's access changed after they answered");
      assert.lengthOf(machine.sends, 0);
      assert.isTrue(
        task.openQuestions
          .at(-1)!
          .text.startsWith("I may not have passed on an answer to mac-studio:"),
      );
      assert.lengthOf(yield* pendingForwards, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("says it may have reached the host when an earlier send's outcome was lost", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* askedOnMachine(machine);
      // The host takes the answer, but the reply is lost, so the forward stays pending.
      machine.refuseSendWith = "host_unavailable";
      yield* say("U1", "answer: use main", "answer");
      yield* until("first send", () => machine.sends.length >= 1);
      yield* narrow("U1");
      machine.refuseSendWith = undefined;
      const attempted = machine.sends.length;
      yield* reasked("Colleague's access changed after they answered");
      assert.lengthOf(machine.sends, attempted);
      assert.lengthOf(yield* pendingForwards, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("is not sent when its sender loses access while the call is being made", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* askedOnMachine(machine);
      const sql = yield* SqlClient.SqlClient;
      machine.beforeHostCall = (call) =>
        call.tool === "goat_thread_send"
          ? sql`UPDATE channel_identities SET granted_scopes_json = ${JSON.stringify(WITHOUT_MEMORY)} WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`.pipe(
              Effect.asVoid,
              Effect.orDie,
            )
          : Effect.void;
      yield* say("U1", "answer: use main", "answer");
      yield* reasked("Colleague's access changed after they answered");
      assert.lengthOf(machine.sends, 0);
      assert.lengthOf(yield* pendingForwards, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  // A remote run keeps the memory recorded for it, so the requester's own answer still needs that
  // memory (requesterForDispatch); the sender check adds nothing for them.
  it.effect("is sent for an allowed colleague and for the requester themself", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* askedOnMachine(machine);
      yield* say("U1", "answer: use main", "answer");
      yield* until("colleague's answer sent", () => sent(machine, "use main"));
      const correlationId = correlationOf(machine);
      machine.report(correlationId, "needs_input", "Which remote?");
      machine.finishRun(correlationId, "completed", "Waiting again.");
      yield* until("second question", (task) => task.status === "waiting_input");
      yield* say("U2", "answer: origin", "own-answer");
      yield* until("own answer sent", () => sent(machine, "origin"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the instruction when the sender's display name is very long", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* askedOnMachine(machine, "N".repeat(500));
      machine.down = true;
      yield* say("U1", "answer: use main", "answer");
      yield* settle();
      yield* narrow("U1");
      machine.down = false;
      const task = yield* reasked("Answer again if it still matters");
      const text = task.openQuestions.at(-1)!.text;
      assert.isTrue(text.startsWith("I may not have passed on an answer to mac-studio:"));
      assert.notInclude(text, "N".repeat(81));
    }).pipe(Effect.provide(harness.layer));
  });
});
