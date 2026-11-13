import { assert, describe, it } from "@effect/vitest";
import type { AuthEnvironmentScope } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { REMOTE_COPY } from "./channelRemoteCopy.ts";
import {
  RemoteMachine,
  correlationOf,
  remoteScript,
  settle,
  until,
} from "./testing/RemoteMachine.ts";
import {
  makeHarness,
  onlyTask,
  owner,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";
import { taskWriteMilestones } from "./testkit/channelWriteMilestones.ts";
import { trackForwards } from "./testkit/remoteForwardFibers.ts";

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

type AccessChange = "memory" | "operate" | "mode" | "unlinked";

const change = (user: string, what: AccessChange = "memory") =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    switch (what) {
      case "memory":
        return sql`UPDATE channel_identities SET granted_scopes_json = ${JSON.stringify(WITHOUT_MEMORY)} WHERE connection_id = 'slack-1' AND external_actor_id = ${user}`;
      case "operate":
        return sql`UPDATE channel_identities SET granted_scopes_json = ${JSON.stringify(["orchestration:read", "memory:read"])} WHERE connection_id = 'slack-1' AND external_actor_id = ${user}`;
      case "mode":
        return sql`UPDATE channel_identities SET runtime_mode_ceiling = 'approval-required' WHERE connection_id = 'slack-1' AND external_actor_id = ${user}`;
      case "unlinked":
        return sql`DELETE FROM channel_identities WHERE connection_id = 'slack-1' AND external_actor_id = ${user}`;
    }
  });

const narrow = (user: string) => change(user);

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
    const writes = yield* taskWriteMilestones();
    yield* say("U2", "do@mac-studio: pick a branch", "start");
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
    yield* writes.waitFor((task) => task.status === "running");
    const correlationId = correlationOf(machine);
    machine.report(correlationId, "needs_input", "Which branch?");
    machine.finishRun(correlationId, "completed", "Waiting for an answer.");
    return yield* writes.waitFor((task) => task.status === "waiting_input");
  });

const pendingForwards = Effect.flatMap(ChannelLedger.ChannelLedger, (ledger) =>
  ledger.listPendingForwards(10),
);

const sent = (machine: RemoteMachine, text: string) =>
  machine.sends.some((send) => (send.message as string).includes(text));

/** The open questions that tell someone their answer may not have reached the other machine. */
const toldMayNotHavePassedOn = Effect.map(onlyTask, (task) =>
  task.openQuestions
    .map((question) => question.text)
    .filter((text) => text.includes("may not have passed on")),
);

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

  it.effect.each(["operate", "mode", "unlinked"] as const)(
    "is not sent once its sender's access changed (%s)",
    (what) => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        yield* askedOnMachine(machine);
        machine.down = true;
        yield* say("U1", "answer: use main", "answer");
        yield* settle();
        yield* change("U1", what);
        machine.down = false;
        yield* reasked("Colleague's access changed after they answered");
        assert.lengthOf(machine.sends, 0);
        assert.lengthOf(yield* pendingForwards, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("is not sent again when an earlier send failed and its sender then lost access", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* askedOnMachine(machine);
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

  it.effect(
    "tells the requester it may have arrived when the host took it but the reply was lost",
    () => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        yield* askedOnMachine(machine);
        const correlationId = correlationOf(machine);
        const runsBefore = machine.runs(correlationId).length;
        const sql = yield* SqlClient.SqlClient;
        let attempts = 0;
        // The host takes the first send; the sender loses access just before the retry.
        machine.beforeHostCall = (call) =>
          call.tool === "goat_thread_send" && ++attempts === 2
            ? sql`UPDATE channel_identities SET granted_scopes_json = ${JSON.stringify(WITHOUT_MEMORY)} WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`.pipe(
                Effect.asVoid,
                Effect.orDie,
              )
            : Effect.void;
        machine.dropSendReply = true;
        yield* say("U1", "answer: use main", "answer");
        const task = yield* reasked("I may not have passed on an answer to mac-studio:");
        assert.isTrue(task.openQuestions.at(-1)!.text.includes("Answer again if it still matters"));
        assert.lengthOf(
          machine.sends.filter((send) => (send.message as string).includes("use main")),
          1,
        );
        assert.lengthOf(machine.runs(correlationId), runsBefore + 1);
        assert.lengthOf(yield* pendingForwards, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "regression: an answer whose requester is unlinked is dropped unsent, and the requester told",
    () => {
      const { machine, harness } = remoteHarness();
      const forwards = trackForwards();
      return Effect.gen(function* () {
        const asked = yield* askedOnMachine(machine);
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        machine.down = true;
        yield* say("U1", "answer: use main", "answer");
        yield* runtime.drain;
        yield* forwards.settled;
        // While the machine is unreachable the answer waits, unsent.
        assert.lengthOf(yield* pendingForwards, 1);
        yield* change("U2", "unlinked");
        machine.down = false;
        yield* runtime.drain;
        yield* forwards.settled;
        assert.lengthOf(machine.sends, 0);
        assert.lengthOf(yield* pendingForwards, 0);
        assert.deepStrictEqual(yield* toldMayNotHavePassedOn, [
          REMOTE_COPY.requesterChanged(machine.host),
        ]);
        const ledger = yield* ChannelLedger.ChannelLedger;
        assert.isUndefined((yield* ledger.getTask(asked.taskId))?.pendingAnswerMessageId);
      }).pipe(forwards.observe, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "regression: an answer whose requester is unlinked inside the final check before the request is dropped unsent, and the requester told",
    () => {
      const { machine, harness } = remoteHarness();
      const forwards = trackForwards();
      return Effect.gen(function* () {
        const asked = yield* askedOnMachine(machine);
        const ledger = yield* ChannelLedger.ChannelLedger;
        const sql = yield* SqlClient.SqlClient;
        const findIdentity = ledger.findIdentity;
        let armed = false;
        let unlinked = false;
        // authorityFor reads the requester first; the unlink lands right after, before senderGate.
        Object.assign(ledger, {
          findIdentity: (input: Parameters<typeof findIdentity>[0]) => {
            if (!armed || input.externalActorId !== "U2") return findIdentity(input);
            armed = false;
            return findIdentity(input).pipe(
              Effect.tap(() =>
                sql`DELETE FROM channel_identities WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`.pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      unlinked = true;
                    }),
                  ),
                  Effect.orDie,
                ),
              ),
            );
          },
        });
        machine.beforeHostCall = (call) =>
          Effect.sync(() => {
            if (call.tool === "goat_thread_send") armed = true;
          });
        yield* say("U1", "answer: use main", "answer");
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        yield* forwards.settled;
        // The final authorization before the request read U2 linked in authorityFor and unlinked in
        // senderGate, so it refused. An unlink after that check and before the send itself is the
        // transport's check-then-send window, which this test does not cover.
        assert.isTrue(unlinked);
        assert.isFalse(sent(machine, "use main"));
        assert.lengthOf(yield* pendingForwards, 0);
        assert.deepStrictEqual(yield* toldMayNotHavePassedOn, [
          REMOTE_COPY.requesterChanged(machine.host),
        ]);
        assert.isUndefined((yield* ledger.getTask(asked.taskId))?.pendingAnswerMessageId);
      }).pipe(forwards.observe, Effect.provide(harness.layer));
    },
  );

  // Answers recorded before senders were stored keep the requester-only check they had.
  it.effect("is sent for an answer recorded without its sender", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* askedOnMachine(machine);
      machine.down = true;
      yield* say("U1", "answer: use main", "answer");
      yield* settle();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_task_events SET event_json = json_remove(event_json, '$.payload.sender') WHERE type = 'task.question.answered'`;
      const stored = yield* sql<{
        readonly senders: number;
      }>`SELECT COUNT(*) AS senders FROM channel_task_events WHERE type = 'task.question.answered' AND json_extract(event_json, '$.payload.sender') IS NOT NULL`;
      assert.strictEqual(stored[0]!.senders, 0);
      yield* narrow("U1");
      machine.down = false;
      yield* until("legacy answer sent", () => sent(machine, "use main"));
    }).pipe(Effect.provide(harness.layer));
  });
});
