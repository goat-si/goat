import { assert, describe, it } from "@effect/vitest";
import { type RuntimeMode, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../serverSettings.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { REMOTE_COPY } from "./channelRemoteCopy.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { taskWriteMilestones } from "./testkit/channelWriteMilestones.ts";
import { trackForwards } from "./testkit/remoteForwardFibers.ts";
import {
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";
import { RemoteMachine, correlationOf, remoteScript } from "./testing/RemoteMachine.ts";

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
    const writes = yield* taskWriteMilestones();
    const gateway = yield* ChannelGateway.ChannelGateway;
    yield* gateway.ingest(slackInput(request, key + "-1"), slackContext);
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
    yield* writes.waitFor((task) => task.status === "running");
    const correlationId = correlationOf(machine);
    machine.report(correlationId, "needs_input", "Which one?");
    machine.finishRun(correlationId, "completed", "Asked.");
    yield* writes.waitFor((task) => task.status === "waiting_input");
    return { correlationId, writes };
  });

export const answer = (key: string) =>
  ChannelGateway.ChannelGateway.pipe(
    Effect.flatMap((gateway) =>
      gateway.ingest(slackInput("answer: the first", key + "-answer"), slackContext),
    ),
    Effect.andThen(ChannelRuntime.ChannelRuntime),
    Effect.flatMap((runtime) => runtime.drain),
  );

/** The remote host took the answer: its event is recorded as forwarded. */
const answerSent = (
  _: unknown,
  state: { readonly forwarded?: ReadonlyArray<string> } | undefined,
) => (state?.forwarded?.length ?? 0) > 0;

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
        const { writes } = yield* askedOnRemote(machine, request, placement + "-allowed");
        yield* answer(placement + "-allowed");
        yield* writes.waitFor(answerSent);
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

const revoke = (user = "U1") =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) =>
        sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = ${user}`,
    ),
    Effect.orDie,
    Effect.asVoid,
  );

/** Runs `effect` once, right before the first answer send reaches the host. */
const onFirstSend = (machine: RemoteMachine, effect: Effect.Effect<void>) => {
  machine.beforeHostCall = (call) =>
    call.tool === "goat_thread_send"
      ? Effect.suspend(() => {
          machine.beforeHostCall = undefined;
          return effect;
        })
      : Effect.void;
};

const openQuestionTexts = Effect.map(onlyTask, (task) =>
  task.openQuestions.map((question) => question.text),
);

/** One more runtime pass, with the forward attempt it starts run to its end. */
const nextAttempt = (forwards: ReturnType<typeof trackForwards>) =>
  ChannelRuntime.ChannelRuntime.pipe(
    Effect.flatMap((runtime) => runtime.drain),
    Effect.andThen(forwards.settled),
  );

const answerFrom = (user: string, key: string) =>
  ChannelGateway.ChannelGateway.pipe(
    Effect.flatMap((gateway) =>
      gateway.ingest(
        slackInput("answer: the first", key + "-answer", undefined, user),
        slackContext,
      ),
    ),
    Effect.andThen(ChannelRuntime.ChannelRuntime),
    Effect.flatMap((runtime) => runtime.drain),
  );

describe("remote answers when the requester's or sender's authority is lost", () => {
  it.effect(
    "regression: a requester revoked while their answer is sent ends the forward and is told",
    () => {
      const { machine, harness } = pinnedHarness();
      return Effect.gen(function* () {
        yield* askedOnRemote(machine, "do@mac-studio: ask me", "revoked-during");
        const sql = yield* SqlClient.SqlClient;
        onFirstSend(machine, revoke().pipe(Effect.provideService(SqlClient.SqlClient, sql)));
        const writes = yield* taskWriteMilestones();
        yield* answer("revoked-during");
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        const told = REMOTE_COPY.requesterChanged(machine.host);
        const task = yield* writes.waitFor((task) =>
          task.openQuestions.some((question) => question.text === told),
        );
        const ledger = yield* ChannelLedger.ChannelLedger;
        assert.lengthOf(machine.sends, 0);
        assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
        assert.isUndefined((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "regression: an answer whose reply was lost is not sent again once the requester is revoked",
    () => {
      const { machine, harness } = pinnedHarness();
      const forwards = trackForwards();
      return Effect.gen(function* () {
        yield* askedOnRemote(machine, "do@mac-studio: ask me", "lost-reply");
        machine.dropSendReply = true;
        yield* answer("lost-reply");
        yield* forwards.settled;
        assert.isAtLeast(machine.sends.length, 1);
        yield* revoke();
        // Every send counted here was authorized before the revocation committed.
        const delivered = machine.sends.length;
        machine.dropSendReply = false;
        yield* nextAttempt(forwards);
        const told = REMOTE_COPY.requesterChanged(machine.host);
        assert.deepStrictEqual(yield* openQuestionTexts, [told]);
        // The words allow that an earlier attempt arrived; nothing is sent after the revocation.
        assert.include(told, "may not have passed on");
        assert.lengthOf(machine.sends, delivered);
      }).pipe(forwards.observe, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "authority: a failed read of the requester's link leaves the answer to send later",
    () => {
      const { machine, harness } = pinnedHarness();
      const forwards = trackForwards();
      return Effect.gen(function* () {
        yield* askedOnRemote(machine, "do@mac-studio: ask me", "unreadable");
        const sql = yield* SqlClient.SqlClient;
        const away = sql`ALTER TABLE channel_identities RENAME TO channel_identities_away`.pipe(
          Effect.orDie,
          Effect.asVoid,
        );
        const back = sql`ALTER TABLE channel_identities_away RENAME TO channel_identities`.pipe(
          Effect.orDie,
          Effect.asVoid,
        );
        onFirstSend(machine, away);
        let denied = false;
        machine.onAuthorizationDenied = (call) =>
          call.tool === "goat_thread_send"
            ? Effect.suspend(() => {
                machine.onAuthorizationDenied = undefined;
                denied = true;
                return back;
              })
            : Effect.void;
        yield* answer("unreadable");
        yield* forwards.settled;
        // The drain may already have retried; only a forward still pending needs another pass.
        const ledger = yield* ChannelLedger.ChannelLedger;
        if ((yield* ledger.listPendingForwards(10)).length > 0) yield* nextAttempt(forwards);
        assert.isTrue(denied);
        assert.lengthOf(machine.sends, 1);
        assert.deepStrictEqual(yield* openQuestionTexts, []);
        assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      }).pipe(forwards.observe, Effect.provide(harness.layer));
    },
  );

  it.effect.each([
    ["requester", "U1"],
    ["delegated sender", "U2"],
  ] as const)(
    "authority: a %s losing access as the attempt is moved past is not refused by that attempt",
    ([, user]) => {
      const { machine, harness } = pinnedHarness();
      return Effect.gen(function* () {
        yield* askedOnRemote(machine, "do@mac-studio: ask me", "moved-" + user);
        if (user !== "U1") yield* linkSlackUser(user);
        const writes = yield* taskWriteMilestones();
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const sql = yield* SqlClient.SqlClient;
        const task = yield* onlyTask;
        onFirstSend(
          machine,
          Effect.gen(function* () {
            yield* revoke(user);
            yield* ledger.updateRemoteWorker({
              owner: runtime.ownerToken,
              now: "2026-10-12T02:00:00.000Z",
              update: {
                taskId: task.taskId,
                update: (json) =>
                  JSON.stringify({ ...JSON.parse(json!), remoteThreadId: "moved-thread" }),
              },
            });
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
        );
        yield* answerFrom(user, "moved-" + user);
        yield* runtime.drain;
        const [pending] = yield* ledger.listPendingForwards(10);
        yield* runtime.drain;
        if (pending !== undefined) yield* writes.waitForForward(pending.sequence);
        assert.lengthOf(machine.sends, 0);
        assert.deepStrictEqual(
          (yield* openQuestionTexts).filter((text) => text.includes("may not have passed on")),
          [],
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("authority: a delegated sender who still may answer has the answer sent", () => {
    const { machine, harness } = pinnedHarness();
    return Effect.gen(function* () {
      const { writes } = yield* askedOnRemote(
        machine,
        "do@mac-studio: ask me",
        "delegated-allowed",
      );
      yield* linkSlackUser("U2");
      yield* answerFrom("U2", "delegated-allowed");
      yield* writes.waitFor(answerSent);
      assert.deepStrictEqual(yield* openQuestionTexts, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "authority: a delegated sender revoked while the answer is sent is told it may not have arrived",
    () => {
      const { machine, harness } = pinnedHarness();
      return Effect.gen(function* () {
        const { writes } = yield* askedOnRemote(
          machine,
          "do@mac-studio: ask me",
          "delegated-revoked",
        );
        yield* linkSlackUser("U2");
        const sql = yield* SqlClient.SqlClient;
        onFirstSend(machine, revoke("U2").pipe(Effect.provideService(SqlClient.SqlClient, sql)));
        yield* answerFrom("U2", "delegated-revoked");
        yield* writes.waitFor((task) =>
          task.openQuestions.some((question) =>
            question.text.includes("may not have passed on an answer"),
          ),
        );
        assert.lengthOf(machine.sends, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("remote answer refusals", () => {
  it.effect("regression: a mode refusal leaves a newer answer's fence in place", () => {
    const { machine, harness } = pinnedHarness();
    machine.refuseSendWith = "runtime_mode_escalation_denied";
    return Effect.gen(function* () {
      yield* askedOnRemote(machine, "do@mac-studio: ask me", "fence");
      const sql = yield* SqlClient.SqlClient;
      onFirstSend(
        machine,
        sql`UPDATE channel_tasks SET pending_answer_message_id = 'later-answer-fence'`.pipe(
          Effect.orDie,
          Effect.asVoid,
        ),
      );
      const writes = yield* taskWriteMilestones();
      yield* answer("fence");
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      const refused = REMOTE_COPY.answerRefused(machine.host, "the first");
      const task = yield* writes.waitFor((task) =>
        task.openQuestions.some((question) => question.text === refused),
      );
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.strictEqual(
        (yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId,
        "later-answer-fence",
      );
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "authority: a mode refusal after a delivered answer whose reply was lost says it may have arrived",
    () => {
      const { machine, harness } = pinnedHarness();
      const forwards = trackForwards();
      return Effect.gen(function* () {
        yield* askedOnRemote(machine, "do@mac-studio: ask me", "lost-then-refused");
        machine.dropSendReply = true;
        yield* answer("lost-then-refused");
        yield* forwards.settled;
        assert.isAtLeast(machine.sends.length, 1);
        machine.dropSendReply = false;
        machine.refuseSendWith = "runtime_mode_escalation_denied";
        yield* nextAttempt(forwards);
        const refused = REMOTE_COPY.answerRefused(machine.host, "the first");
        assert.deepStrictEqual(yield* openQuestionTexts, [refused]);
        assert.include(refused, "may not have passed on");
      }).pipe(forwards.observe, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "regression: a mode refusal asks once even when finishing its forward as a second write would fail",
    () => {
      const { machine, harness } = pinnedHarness();
      machine.refuseSendWith = "runtime_mode_escalation_denied";
      return Effect.gen(function* () {
        const { writes } = yield* askedOnRemote(machine, "do@mac-studio: ask me", "complete-fails");
        const ledger = yield* ChannelLedger.ChannelLedger;
        const writable = ledger as { completeForward: typeof ledger.completeForward };
        const complete = writable.completeForward;
        let armed = true;
        writable.completeForward = (input) => {
          if (!armed) return complete(input);
          armed = false;
          return Effect.fail(
            new ChannelLedger.ChannelLedgerError({ reason: "persistence", detail: "injected" }),
          );
        };
        yield* answer("complete-fails");
        const refused = REMOTE_COPY.answerRefused(machine.host, "the first");
        yield* writes.waitFor((task) =>
          task.openQuestions.some((question) => question.text === refused),
        );
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        assert.deepStrictEqual(
          (yield* openQuestionTexts).filter((text) => text === refused),
          [refused],
        );
        assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "concurrency: a refusal whose transaction fails after marking the forward done rolls back whole",
    () => {
      const { machine, harness } = pinnedHarness();
      machine.refuseSendWith = "runtime_mode_escalation_denied";
      return Effect.gen(function* () {
        yield* askedOnRemote(machine, "do@mac-studio: ask me", "rollback");
        const sql = yield* SqlClient.SqlClient;
        const ledger = yield* ChannelLedger.ChannelLedger;
        // The refusal marks its forward done first, then fails on the question's event.
        yield* sql`CREATE TRIGGER refusal_fails BEFORE INSERT ON channel_task_events
          WHEN NEW.type = 'task.question.opened' BEGIN SELECT RAISE(ABORT, 'injected'); END`;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const writable = ledger as { applyTaskEvent: typeof ledger.applyTaskEvent };
        const apply = writable.applyTaskEvent;
        const failed = yield* Deferred.make<void>();
        writable.applyTaskEvent = (input) =>
          apply(input).pipe(Effect.tapError(() => Deferred.succeed(failed, undefined)));
        const writes = yield* taskWriteMilestones();
        yield* answer("rollback");
        yield* runtime.drain;
        yield* Deferred.await(failed);
        // While the trigger stands every refusal fails whole: no question, the forward still pending.
        assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
        assert.deepStrictEqual(yield* openQuestionTexts, []);
        yield* sql`DROP TRIGGER refusal_fails`;
        yield* runtime.drain;
        const refused = REMOTE_COPY.answerRefused(machine.host, "the first");
        yield* writes.waitFor((task) =>
          task.openQuestions.some((question) => question.text === refused),
        );
        assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
        const opened = yield* sql<{
          readonly event_json: string;
        }>`SELECT event_json FROM channel_task_events WHERE type = 'task.question.opened'`;
        assert.lengthOf(
          opened.filter((row) => row.event_json.includes("now runs above")),
          1,
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "authority: an attempt moved past after its authority check is not refused by that attempt",
    () => {
      const { machine, harness } = pinnedHarness();
      return Effect.gen(function* () {
        yield* askedOnRemote(machine, "do@mac-studio: ask me", "moved-after");
        const sql = yield* SqlClient.SqlClient;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const writes = yield* taskWriteMilestones();
        const taskId = (yield* onlyTask).taskId;
        onFirstSend(machine, revoke().pipe(Effect.provideService(SqlClient.SqlClient, sql)));
        // Between the refused authorization and the refusal, the task rebinds to another thread.
        machine.onAuthorizationDenied = (call) =>
          call.tool === "goat_thread_send"
            ? Effect.gen(function* () {
                machine.onAuthorizationDenied = undefined;
                const latest = (yield* ledger.getTask(taskId))!;
                yield* commitTransition(
                  ledger,
                  latest,
                  {
                    type: "task.worker.bound",
                    payload: {
                      worker: { ...latest.task.worker!, threadId: ThreadId.make("moved-thread") },
                    },
                  },
                  { owner: runtime.ownerToken },
                );
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)
            : Effect.void;
        yield* answer("moved-after");
        yield* runtime.drain;
        const [pending] = yield* ledger.listPendingForwards(10);
        yield* runtime.drain;
        if (pending !== undefined) yield* writes.waitForForward(pending.sequence);
        assert.deepStrictEqual(
          (yield* openQuestionTexts).filter((text) => text.includes("no longer covers")),
          [],
        );
        assert.lengthOf(machine.sends, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "regression: a remote state taken over after the authority check, with the task unchanged, is not refused against",
    () => {
      const { machine, harness } = pinnedHarness();
      return Effect.gen(function* () {
        yield* askedOnRemote(machine, "do@mac-studio: ask me", "state-after");
        const sql = yield* SqlClient.SqlClient;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const writes = yield* taskWriteMilestones();
        const taskId = (yield* onlyTask).taskId;
        onFirstSend(machine, revoke().pipe(Effect.provideService(SqlClient.SqlClient, sql)));
        // After the refused authorization read it, the remote state moves on; the task row does not.
        machine.onAuthorizationDenied = (call) =>
          call.tool === "goat_thread_send"
            ? Effect.suspend(() => {
                machine.onAuthorizationDenied = undefined;
                return ledger.updateRemoteWorker({
                  owner: runtime.ownerToken,
                  now: "2026-10-12T02:00:00.000Z",
                  update: {
                    taskId,
                    update: (json) =>
                      JSON.stringify({ ...JSON.parse(json!), remoteThreadId: "moved-thread" }),
                  },
                });
              }).pipe(Effect.orDie, Effect.asVoid)
            : Effect.void;
        yield* answer("state-after");
        yield* runtime.drain;
        const [pending] = yield* ledger.listPendingForwards(10);
        yield* runtime.drain;
        if (pending !== undefined) yield* writes.waitForForward(pending.sequence);
        assert.deepStrictEqual(
          (yield* openQuestionTexts).filter((text) => text.includes("no longer covers")),
          [],
        );
        assert.lengthOf(machine.sends, 0);
        assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
