import { assert, describe, it } from "@effect/vitest";
import type { AuthEnvironmentScope } from "@goat/contracts";
import { ChannelQuestionId, CommandId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelBotSession from "./ChannelBotSession.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelSessionTaskActions from "./channelSessionTaskActions.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { taskIdFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { ask, botModel, runsOf, sessionHarness } from "./ChannelBotSession.testkit.ts";
import {
  environmentId,
  goatInput,
  owner,
  projectId,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

/** A Slack user's message in one Slack thread, read but not yet dispatched. */
const receiveFromTeammate = (text: string, key: string, user = "U2") =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const reception = yield* ChannelReceptionService.ChannelReceptionService;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    yield* runtime.drain;
    const ingested = yield* gateway.ingest(
      slackInput(text, key, "1760000000.000900", user),
      slackMemoryContext,
    );
    yield* reception.receive(ingested.inputId, runtime.ownerToken);
    return (yield* ledger.getTask(taskIdFor(ingested.inputId, 0)))!.task;
  });

const dispatchNow = (text: string, key: string, user = "U2") =>
  Effect.gen(function* () {
    const task = yield* receiveFromTeammate(text, key, user);
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(task.taskId, runtime.ownerToken);
    return (yield* (yield* ChannelLedger.ChannelLedger).getTask(task.taskId))!.task;
  });

/** The teammate's message, claimed for a session turn with this recorded memory ceiling. */
const claimedFromTeammate = (key: string, memoryGrantCeiling?: "read") =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const task = yield* receiveFromTeammate("look: claimed look " + key, key);
    yield* commitTransition(
      ledger,
      (yield* ledger.getTask(task.taskId))!,
      {
        type: "task.dispatch.claimed",
        payload: {
          generation: task.generation,
          target: {
            environmentId,
            projectId,
            modelSelection: botModel,
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            ...(memoryGrantCeiling === undefined ? {} : { memoryGrantCeiling }),
          },
          leaseExpiresAt: "2026-10-12T00:00:00.000Z",
        },
      },
      { owner: runtime.ownerToken },
    );
    return (yield* ledger.getTask(task.taskId))!;
  });
const slackMemoryContext = {
  ...slackContext,
  grantedScopes: [...slackContext.grantedScopes, "memory:read", "memory:write"],
} satisfies typeof slackContext;

const withScopes = <C extends { readonly grantedScopes: ReadonlyArray<AuthEnvironmentScope> }>(
  context: C,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) => ({ ...context, grantedScopes: [...context.grantedScopes, ...scopes] });

/** Links a Slack user with these memory scopes; the creator holds both so the link keeps them. */
const linkTeammateWithMemory = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  user = "U2",
  principalId = "teammate",
) =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const { code } = yield* identities.createLink(
      {
        connectionId: "slack-1",
        runtimeModeCeiling: "auto-accept-edits",
        grantedScopes: ["orchestration:read", "orchestration:operate", ...scopes],
      },
      withScopes({ ...owner, principalId, displayName: principalId }, [
        "memory:read",
        "memory:write",
      ]),
    );
    yield* gateway.linkIdentity(
      {
        connectionId: "slack-1",
        externalActorId: user,
        code,
        idempotencyKey: "memory-link-" + user,
        replyAddress: slackInput("", "unused").replyAddress,
      },
      slackContext,
    );
  });

/** The sendToThread input that carried this text into a session. */
const sendOf = (harness: ReturnType<typeof sessionHarness>, needle: string) => {
  const sends = harness.world.sends.filter((send) => send.text.includes(needle));
  assert.lengthOf(sends, 1, needle);
  return sends[0]!;
};

describe("GOAT Bot session runs after the first at the requester's memory ceiling", () => {
  it.effect.each([
    { scopes: [], ceiling: undefined },
    { scopes: ["memory:read"], ceiling: "read" },
    { scopes: ["memory:read", "memory:write"], ceiling: "read_write" },
  ] as const)(
    "sends a later request in the session at ceiling $ceiling, as the user",
    ({ scopes, ceiling }) => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const requester = withScopes(rpcContext, scopes);
        const first = yield* ask("look: first look", "memory-1", requester);
        const second = yield* ask("look: second look", "memory-2", requester);
        assert.strictEqual(second.worker?.threadId, first.worker?.threadId);
        assert.lengthOf(harness.world.launches, 1);
        assert.strictEqual(harness.world.launches[0]!.initialMessage?.memoryGrantCeiling, ceiling);
        const send = sendOf(harness, "second look");
        assert.strictEqual(send.memoryGrantCeiling, ceiling);
        assert.strictEqual(send.createdBy, "user");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("stores the requester's ceiling on the later request's real run", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const requester = withScopes(rpcContext, ["memory:read"]);
      const first = yield* ask("look: first look", "real-memory-1", requester);
      const threadId = first.worker!.threadId;
      // From here the session thread is a real orchestrator thread, as in the real-steer test.
      harness.world.runs.delete(threadId);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("real-memory-session"),
        threadId,
        projectId: first.target!.projectId,
        title: "Real session",
        modelSelection: first.target!.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
      const second = yield* ask("look: second look", "real-memory-2", requester);
      assert.strictEqual(second.worker?.threadId, threadId);
      const runs = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs;
      assert.lengthOf(runs, 1);
      assert.strictEqual(runs[0]!.memoryGrantCeiling, "read");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("sends a member bot session's later request at the requester's ceiling", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const member = yield* (yield* ChannelBotMembers.ChannelBotMembers).create(
        {
          clientRequestId: "memory-member",
          name: "Helper",
          avatar: null,
          purpose: "Checks builds.",
          defaultModelSelection: null,
        },
        owner,
      );
      const requester = withScopes(rpcContext, ["memory:read"]);
      const askMember = (text: string, key: string) =>
        Effect.gen(function* () {
          const gateway = yield* ChannelGateway.ChannelGateway;
          const runtime = yield* ChannelRuntime.ChannelRuntime;
          const ledger = yield* ChannelLedger.ChannelLedger;
          yield* runtime.drain;
          const ingested = yield* gateway.ingest(
            {
              ...goatInput(text, key),
              conversationKey: member.sessionThreadId,
              replyAddress: { kind: "goat", environmentId, threadId: member.sessionThreadId },
            },
            requester,
          );
          assert.strictEqual((yield* ledger.getInput(ingested.inputId))?.botId, member.botId);
          yield* (yield* ChannelReceptionService.ChannelReceptionService).receive(
            ingested.inputId,
            runtime.ownerToken,
          );
          yield* runtime.drain;
          yield* (yield* ChannelWorkerReports.ChannelWorkerReports).reconcile(runtime.ownerToken);
          return (yield* ledger.getTask(taskIdFor(ingested.inputId, 0)))!.task;
        });
      const first = yield* askMember("look: member first", "member-memory-1");
      const second = yield* askMember("look: member second", "member-memory-2");
      assert.strictEqual(second.worker?.threadId, first.worker?.threadId);
      // Creating the member launched its own thread; only the session's launch counts here.
      const launches = harness.world.launches.filter(
        (launch) => launch.threadId === first.worker?.threadId,
      );
      assert.lengthOf(launches, 1);
      assert.strictEqual(launches[0]!.initialMessage?.memoryGrantCeiling, "read");
      assert.strictEqual(sendOf(harness, "member second").memoryGrantCeiling, "read");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("forwards follow-ups at the teammate's ceiling, never into a run above it", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkTeammateWithMemory(["memory:read", "memory:write"]);
      const task = yield* dispatchNow("look: task", "memory-follow-1");
      assert.strictEqual(task.target?.memoryGrantCeiling, "read_write");
      // The session's run holds what its launch carried, as the orchestrator stores it.
      const threadId = task.worker!.threadId;
      const [run] = harness.world.runs.get(threadId)!;
      harness.world.runs.set(threadId, [{ ...run!, memoryGrantCeiling: "read_write" }]);
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const followUp = (text: string, key: string) =>
        Effect.gen(function* () {
          const input = yield* gateway.ingest(
            slackInput("more:" + task.taskId + " " + text, key, "1760000000.000900", "U2"),
            slackMemoryContext,
          );
          yield* reception.receive(input.inputId, runtime.ownerToken);
          for (const pending of yield* ledger.listPendingForwards(10))
            yield* dispatcher.forward(pending, runtime.ownerToken);
        });
      yield* followUp("check logs", "memory-follow-2");
      const steered = sendOf(harness, "check logs");
      assert.strictEqual(steered.mode, "steer");
      assert.strictEqual(steered.memoryGrantCeiling, "read_write");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_identities SET granted_scopes_json = '["orchestration:read","orchestration:operate","memory:read"]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`;
      yield* followUp("check disks", "memory-follow-3");
      // The running run may still write memory, so the lowered follow-up waits as its own run.
      const queued = sendOf(harness, "check disks");
      assert.strictEqual(queued.mode, "queue");
      assert.strictEqual(queued.memoryGrantCeiling, "read");
      const runs = harness.world.runs.get(threadId)!;
      assert.lengthOf(runs, 2);
      assert.strictEqual(runs[1]!.status, "queued");
      assert.strictEqual((yield* ledger.getTask(task.taskId))!.task.worker?.runId, runs[1]!.id);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("never sends past the task's recorded ceiling, nor any memory without one", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkTeammateWithMemory(["memory:read", "memory:write"]);
      const session = yield* ChannelBotSession.ChannelBotSession;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      /** The sends this one task's serve made. */
      const serve = (key: string, ceiling?: "read") =>
        Effect.gen(function* () {
          const before = harness.world.sends.length;
          const stored = yield* claimedFromTeammate(key, ceiling);
          assert.strictEqual(yield* session.serve(stored, runtime.ownerToken), "served");
          return harness.world.sends.slice(before);
        });
      // The requester could read and write now; each task recorded less when it was claimed.
      assert.lengthOf(yield* serve("cap-read-1", "read"), 0);
      const [readSend] = yield* serve("cap-read-2", "read");
      assert.lengthOf(yield* serve("cap-none-1"), 0);
      const [noneSend] = yield* serve("cap-none-2");
      assert.deepStrictEqual(
        harness.world.launches.map((launch) => launch.initialMessage?.memoryGrantCeiling),
        ["read", undefined],
      );
      assert.strictEqual(readSend?.memoryGrantCeiling, "read");
      assert.isDefined(noneSend);
      assert.notProperty(noneSend!, "memoryGrantCeiling");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("someone else directing a person's GOAT Bot work", () => {
  it.effect.each([
    { scopes: [], allowed: false },
    { scopes: ["memory:read"], allowed: true },
    { scopes: ["memory:read", "memory:write"], allowed: true },
  ] as const)(
    "lets a colleague with memory $scopes follow up, answer and stop a memory task: $allowed",
    ({ scopes, allowed }) => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkTeammateWithMemory(["memory:read"]);
        yield* linkTeammateWithMemory(scopes, "U1", "colleague");
        const task = yield* dispatchNow("look: task", "other-1");
        assert.strictEqual(task.target?.memoryGrantCeiling, "read");
        const gateway = yield* ChannelGateway.ChannelGateway;
        const reception = yield* ChannelReceptionService.ChannelReceptionService;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
        const fromColleague = (text: string, key: string) =>
          Effect.gen(function* () {
            const input = yield* gateway.ingest(
              slackInput(text, key, "1760000000.000900", "U1"),
              slackMemoryContext,
            );
            yield* reception.receive(input.inputId, runtime.ownerToken);
            for (const pending of yield* ledger.listPendingForwards(10))
              yield* dispatcher.forward(pending, runtime.ownerToken);
          });
        yield* fromColleague("more:" + task.taskId + " colleague note", "other-2");
        assert.strictEqual(
          harness.world.sends.some((send) => send.text.includes("colleague note")),
          allowed,
        );
        const questionId = ChannelQuestionId.make("question:other");
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.question.opened",
            payload: {
              question: { questionId, text: "Which disk?", askedAt: "2026-10-12T00:00:00.000Z" },
            },
          },
          { owner: runtime.ownerToken },
        );
        yield* fromColleague("answer:" + task.taskId + " " + questionId + " sda", "other-3");
        const answered = (yield* ledger.getTask(task.taskId))!.task;
        assert.strictEqual(answered.openQuestions.length === 0, allowed);
        yield* fromColleague("stop:" + task.taskId, "other-4");
        assert.strictEqual(
          (yield* ledger.getTask(task.taskId))!.task.status === "cancelled",
          allowed,
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("a session run directing another person's work", () => {
  it.effect("acts with its requester's current memory, not the one recorded on their task", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkTeammateWithMemory(["memory:read"]);
      yield* linkTeammateWithMemory(["memory:read"], "U1", "colleague");
      const source = yield* dispatchNow("look: source", "tool-source");
      const target = yield* dispatchNow("look: target", "tool-target", "U1");
      assert.notStrictEqual(source.worker?.threadId, target.worker?.threadId);
      const threadId = source.worker!.threadId;
      const caller = { threadId, runId: runsOf(harness, threadId)[0]!.id };
      const actions = yield* ChannelSessionTaskActions.ChannelSessionTaskActions;
      const followUp = (clientRequestId: string) =>
        actions.followUp({ caller, taskId: target.taskId, text: "continue", clientRequestId });
      assert.strictEqual((yield* followUp("while-read"))?.type, "task.followup.received");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_identities SET granted_scopes_json = '["orchestration:read","orchestration:operate"]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`;
      assert.strictEqual((yield* Effect.flip(followUp("after-losing-memory"))).reason, "not_found");
    }).pipe(Effect.provide(harness.layer));
  });
});
