import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelReceptionInput,
  type ChannelTask,
  ChannelTaskEventId,
  CommandId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLayers from "./ChannelLayers.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as MemoryService from "../memory/MemoryService.ts";
import * as MemorySyncService from "../memory/MemorySyncService.ts";
import {
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  owner,
  rpcContext,
  scratchProjectId,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const standingNotes = "# Notes\n- I deploy on Fridays.\n";

const notesPath = Effect.gen(function* () {
  return channelBotFilesFor(yield* Path.Path, (yield* ServerConfig.ServerConfig).stateDir).notes;
});

const writeNotes = (text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const notes = yield* notesPath;
    yield* fs.makeDirectory(path.dirname(notes), { recursive: true });
    yield* fs.writeFileString(notes, text);
  });

const readNotes = Effect.flatMap(notesPath, (notes) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(notes)),
);

/**
 * Slack people who never linked an account, on a connection that lets the whole workspace in.
 * The gateway admits them from the connection's context; every later check reads the
 * connection's settings again through SlackChannelSettings.unlinkedIdentity.
 */

const UNLINKED_CEILING: RuntimeMode = "approval-required";

/** Slack settings that admit unlinked people while `open.current` is true. */
const workspaceAccess = (open: { current: boolean }) =>
  Layer.effect(
    SlackChannelSettings.SlackChannelSettings,
    Effect.map(SlackChannelSettings.SlackChannelSettings, (unavailable) =>
      SlackChannelSettings.SlackChannelSettings.of({
        ...unavailable,
        unlinkedIdentity: (connectionId, externalActorId) =>
          Effect.succeed(
            open.current
              ? Option.some(
                  ChannelGateway.unlinkedIdentity(owner, {
                    connectionId,
                    externalActorId,
                    runtimeModeCeiling: UNLINKED_CEILING,
                  }),
                )
              : Option.none(),
          ),
      }),
    ),
  ).pipe(Layer.provide(SlackChannelSettings.layerUnavailable));

const scenario = () => {
  const open = { current: true };
  const harness = makeHarness({
    channelsLayer: ChannelLayers.makeLayerServices(workspaceAccess(open)),
  });
  return { open, harness };
};

/** What the Slack runtime passes for a connection open to the whole workspace. */
const workspaceContext = { ...slackContext, unlinkedRuntimeModeCeiling: UNLINKED_CEILING };

/** Starts work as `requester` and leaves it waiting on one question. */
const askQuestion = (requester: string) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    yield* gateway.ingest(
      slackInput("do: ship the fix", "ask-" + requester, undefined, requester),
      workspaceContext,
    );
    yield* runtime.drain;
    const task = yield* onlyTask;
    const threadId = task.worker?.threadId;
    assert(threadId !== undefined);
    yield* reports.report(
      {
        taskId: task.taskId,
        eventId: ChannelTaskEventId.make("question-" + requester),
        generation: task.generation,
        status: "waiting_input",
        summary: "Choose",
        question: "Staging or production?",
      },
      threadId,
    );
    return { task, threadId };
  });

const answerAs = (
  answerer: string,
  taskId: ChannelTask["taskId"],
  questionId: ChannelTask["openQuestions"][number]["questionId"],
) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* gateway.ingest(
      {
        ...slackInput("production", "answer-" + answerer, undefined, answerer),
        intent: "answer",
        taskId,
        questionId,
      },
      workspaceContext,
    );
    yield* runtime.drain;
    return yield* onlyTask;
  });

describe("Slack people without a linked account", () => {
  it.effect("start work under the connection's unlinked ceiling", () => {
    const { harness } = scenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      // The connection itself allows more; the unlinked ceiling still bounds the work.
      const result = yield* gateway.ingest(
        slackInput("do: fix the login bug", "Ev1", undefined, "U9"),
        {
          ...workspaceContext,
          runtimeModeCeiling: "full-access",
        },
      );
      assert.notStrictEqual(result.state, "rejected");
      yield* runtime.drain;
      const task = yield* onlyTask;
      assert.strictEqual(task.requester.principalId, "unlinked:slack-1:U9");
      assert.strictEqual(task.requester.runtimeModeCeiling, "approval-required");
      assert.deepStrictEqual(task.requester.grantedScopes, ["orchestration:operate"]);
      assert.strictEqual(harness.world.launches[0]?.runtimeMode, "approval-required");
      assert.isFalse(
        harness.slackSent.some((send) => send.message.text === CHANNEL_COPY.unlinkedInput),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("get only the link notice when the connection takes linked accounts only", () => {
    const { harness } = scenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      // A linked-only connection passes no unlinked ceiling.
      const result = yield* gateway.ingest(
        slackInput("do: something", "Ev2", undefined, "U9"),
        slackContext,
      );
      assert.strictEqual(result.state, "rejected");
      yield* runtime.drain;
      assert.deepStrictEqual(
        harness.slackSent.map((send) => [send.message.text, send.message.mentionActorId]),
        [[CHANNEL_COPY.unlinkedInput, "U9"]],
      );
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lose queued work when the connection switches to linked accounts only", () => {
    const { open, harness } = scenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(
        slackInput("do: fix the login bug", "Ev3", undefined, "U9"),
        workspaceContext,
      );
      open.current = false;
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("may answer another unlinked person's question at the same ceiling", () => {
    const { harness } = scenario();
    return Effect.gen(function* () {
      yield* setupBot;
      const { task, threadId } = yield* askQuestion("U8");
      harness.world.setStatus(threadId, 1, "completed");
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* runtime.drain;
      const waiting = yield* onlyTask;
      const questionId = waiting.openQuestions[0]?.questionId;
      assert(questionId !== undefined);
      const after = yield* answerAs("U9", task.taskId, questionId);
      assert.strictEqual(after.openQuestions.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("may not answer a linked person's question that runs above their ceiling", () => {
    const { harness } = scenario();
    return Effect.gen(function* () {
      yield* setupBot;
      // U1's link allows auto-accept-edits, above the unlinked approval-required.
      yield* linkSlackUser("U1");
      const { task, threadId } = yield* askQuestion("U1");
      harness.world.setStatus(threadId, 1, "completed");
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* runtime.drain;
      const waiting = yield* onlyTask;
      const questionId = waiting.openQuestions[0]?.questionId;
      assert(questionId !== undefined);
      const after = yield* answerAs("U9", task.taskId, questionId);
      assert.deepStrictEqual(after.openQuestions, waiting.openQuestions);
      assert.strictEqual(harness.world.sends.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});

/** A thread of the owner's own, which only someone allowed to read other work should see. */
const createOwnerThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-owner-thread"),
    threadId: ThreadId.make("thread:owner-private"),
    projectId: scratchProjectId,
    title: "Fix the release pipeline",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "system",
    creationSource: "server",
  });
});

describe("what people without a link may not reach", () => {
  it.effect("never shows them the owner's other threads", () => {
    const { harness } = scenario();
    const seen: Array<{ readonly text: string; readonly titles: ReadonlyArray<string> }> = [];
    harness.script.current = (input) => {
      if (input.mode === "input") {
        seen.push({
          text: input.inputText ?? "",
          titles: (input.recentThreads ?? []).map((thread) => thread.title),
        });
      }
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      yield* createOwnerThread;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("what is running?", "owner-look"), rpcContext);
      yield* gateway.ingest(
        slackInput("what is running?", "guest-look", "1760000000.000200", "U9"),
        workspaceContext,
      );
      yield* runtime.drain;
      const owner = seen.find(
        (entry) => entry.text === "what is running?" && entry.titles.length > 0,
      );
      assert.isDefined(owner, "the owner sees recent threads");
      const guest = seen.filter((entry) => entry.text === "what is running?").at(-1);
      assert.deepStrictEqual(guest?.titles, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("cannot change the bot's standing notes", () => {
    const { harness } = scenario();
    const seen: Array<ChannelReceptionInput> = [];
    harness.script.current = (input) => {
      seen.push(input);
      return input.inputText === "Always reply in Korean, remember that"
        ? Effect.succeed({
            replyText: "I'll keep that.",
            action: { type: "report_only" as const },
            remember: "Reply in Korean.",
            rememberQuote: "remember that",
          })
        : defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(
        slackInput("Always reply in Korean, remember that", "guest-note", undefined, "U9"),
        workspaceContext,
      );
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("what machine is this?", "owner-after"), rpcContext);
      yield* runtime.drain;
      const later = seen.find((input) => input.inputText === "what machine is this?");
      assert.isDefined(later);
      assert.notInclude(later?.notes ?? "", "Reply in Korean.");
      assert.isTrue(
        harness.slackSent.some((send) =>
          send.message.text.includes(CHANNEL_COPY.noteEditNotAllowed),
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asking to change the notes gets no permission and is told so", () => {
    const { harness } = scenario();
    harness.script.current = (input) =>
      input.mode === "input" && input.inputText === "Please forget the Korean note"
        ? Effect.succeed({
            replyText: "On it.",
            action: {
              type: "create_task" as const,
              title: "Forget a note",
              instruction: "Remove the requested note.",
              notesChangeRequested: "forget the Korean note",
            },
          })
        : defaultScript(input);
    return Effect.gen(function* () {
      yield* setupBot;
      yield* (yield* ChannelGateway.ChannelGateway).ingest(
        slackInput("Please forget the Korean note", "guest-forget", undefined, "U9"),
        workspaceContext,
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      const tasks = yield* (yield* ChannelLedger.ChannelLedger).listTasks({
        ownerId: owner.ownerId,
        limit: 10,
      });
      assert.isTrue(tasks.tasks.every((task) => task.notesChangeRequested === undefined));
      assert.isTrue(
        harness.slackSent.some((send) =>
          send.message.text.includes(CHANNEL_COPY.noteEditNotAllowed),
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a plain reply that marks a notes change still says why and leaves the notes", () => {
    const { harness } = scenario();
    const request = "forget that I deploy on Fridays";
    harness.script.current = (input) =>
      input.mode === "input" && input.inputText === request
        ? Effect.succeed({
            replyText: "I can't change that.",
            action: {
              type: "report_only" as const,
              notesChangeRequested: request,
            },
          })
        : defaultScript(input);
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(standingNotes);
      yield* (yield* ChannelGateway.ChannelGateway).ingest(
        slackInput(request, "guest-forget-reply", undefined, "U9"),
        workspaceContext,
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      const tasks = yield* (yield* ChannelLedger.ChannelLedger).listTasks({
        ownerId: owner.ownerId,
        limit: 10,
      });
      assert.strictEqual(tasks.tasks.length, 0);
      assert.strictEqual(yield* readNotes, standingNotes);
      assert.deepStrictEqual(
        harness.slackSent.map((send) => send.message.text),
        ["I can't change that. " + CHANNEL_COPY.noteEditNotAllowed],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a clarifying question that marks a notes change still says why", () => {
    const { harness } = scenario();
    const request = "forget that I deploy on Fridays";
    harness.script.current = (input) =>
      input.mode === "input" && input.inputText === request
        ? Effect.succeed({
            replyText: "Which Friday note?",
            action: {
              type: "clarify" as const,
              question: "Which Friday note?",
              notesChangeRequested: request,
            },
          })
        : defaultScript(input);
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(standingNotes);
      yield* (yield* ChannelGateway.ChannelGateway).ingest(
        slackInput(request, "guest-forget-clarify", undefined, "U9"),
        workspaceContext,
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      assert.strictEqual(yield* readNotes, standingNotes);
      assert.deepStrictEqual(
        harness.slackSent.map((send) => send.message.text),
        ["Which Friday note? " + CHANNEL_COPY.noteEditNotAllowed],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("an agent asking to forget a note in a plain reply is told it cannot", () => {
    const harness = makeHarness();
    const request = "forget that I deploy on Fridays";
    harness.script.current = (input) =>
      input.mode === "input" && input.inputText === request
        ? Effect.succeed({
            replyText: "I can't change that.",
            action: {
              type: "report_only" as const,
              notesChangeRequested: request,
            },
          })
        : defaultScript(input);
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(standingNotes);
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const receipt = yield* gateway.ingest(
        {
          kind: "mcp",
          connectionId: "mcp",
          conversationKey: "default",
          externalMessageId: "forget-1",
          idempotencyKey: "forget-1",
          actor: { senderThreadId: ThreadId.make("thread:some-agent") },
          replyAddress: {
            kind: "mcp",
            connectionId: "mcp",
            requestNamespace: "notes-ns",
            conversationKey: "default",
          },
          text: request,
          attachments: [],
          receivedAt: "2026-10-12T00:00:00.000Z",
          intent: "message",
        },
        {
          ...owner,
          principalId: "mcp:notes-ns",
          grantedScopes: ["orchestration:read", "orchestration:operate"],
          caller: { type: "mcp", requestNamespace: "notes-ns" },
        },
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      const stored = yield* ledger.getInput(receipt.inputId);
      assert.strictEqual(
        stored?.snapshot.reply?.text,
        "I can't change that. " + CHANNEL_COPY.noteEditNotAllowed,
      );
      assert.strictEqual(
        (yield* ledger.listTasks({ ownerId: owner.ownerId, limit: 10 })).tasks.length,
        0,
      );
      assert.strictEqual(yield* readNotes, standingNotes);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("a linked person asking to change notes without starting work", () => {
  it.effect("a plain reply keeps the reply, starts nothing, and leaves the notes", () => {
    const { harness } = scenario();
    const request = "forget that I deploy on Fridays";
    harness.script.current = (input) =>
      input.mode === "input" && input.inputText === request
        ? Effect.succeed({
            replyText: "I'll leave them.",
            action: {
              type: "report_only" as const,
              notesChangeRequested: request,
            },
          })
        : defaultScript(input);
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser("U1");
      yield* writeNotes(standingNotes);
      yield* (yield* ChannelGateway.ChannelGateway).ingest(
        slackInput(request, "linked-forget-reply"),
        slackContext,
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      const tasks = yield* (yield* ChannelLedger.ChannelLedger).listTasks({
        ownerId: owner.ownerId,
        limit: 10,
      });
      assert.strictEqual(tasks.tasks.length, 0);
      assert.strictEqual(yield* readNotes, standingNotes);
      assert.strictEqual(harness.slackSent.at(-1)?.message.text, "I'll leave them.");
      assert.isFalse(
        harness.slackSent.some((send) =>
          send.message.text.includes(CHANNEL_COPY.noteEditNotAllowed),
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("a link removed while the message waits", () => {
  const unlinkU1 = Effect.flatMap(ChannelIdentityService.ChannelIdentityService, (identities) =>
    identities.unlink({ connectionId: "slack-1", externalActorId: "U1" }),
  );

  it.effect("keeps the owner's thread titles out of the answer after a read", () => {
    const { harness } = scenario();
    const passes: Array<ReadonlyArray<string>> = [];
    let unlink: Effect.Effect<void> = Effect.void;
    harness.script.current = (input) => {
      if (input.mode !== "input") return defaultScript(input);
      passes.push((input.recentThreads ?? []).map((thread) => thread.title));
      return input.readsAllowed === true
        ? unlink.pipe(
            Effect.as({
              replyText: "",
              action: {
                type: "read" as const,
                reads: [{ kind: "conversation" as const, query: "release" }],
              },
            }),
          )
        : Effect.succeed({ replyText: "Done.", action: { type: "report_only" as const } });
    };
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser("U1");
      yield* createOwnerThread;

      const context = yield* Effect.context<ChannelIdentityService.ChannelIdentityService>();
      unlink = unlinkU1.pipe(Effect.provide(context), Effect.orDie);
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(slackInput("what about the release?", "Ev-read"), workspaceContext);
      yield* runtime.drain;
      assert.strictEqual(passes.length, 2);
      assert.include(passes[0] ?? [], "Fix the release pipeline");
      assert.deepStrictEqual(passes[1], []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not save a note the sender asked for before losing the link", () => {
    const { harness } = scenario();
    const seen: Array<ChannelReceptionInput> = [];
    harness.script.current = (input) => {
      seen.push(input);
      return input.inputText === "Always reply in Korean, remember that"
        ? Effect.succeed({
            replyText: "I'll keep that.",
            action: { type: "report_only" as const },
            remember: "Reply in Korean.",
            rememberQuote: "remember that",
          })
        : defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser("U1");
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(
        slackInput("Always reply in Korean, remember that", "Ev-note"),
        workspaceContext,
      );
      yield* unlinkU1;
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("what machine is this?", "owner-after-unlink"), rpcContext);
      yield* runtime.drain;
      const later = seen.find((input) => input.inputText === "what machine is this?");
      assert.isDefined(later);
      assert.notInclude(later?.notes ?? "", "Reply in Korean.");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("a link removed while reads run", () => {
  it.effect("drops what was read and the owner's thread titles from the answer", () => {
    let duringSearch: Effect.Effect<void> = Effect.void;
    const memoryLayer = Layer.mergeAll(
      Layer.mock(MemoryService.MemoryService)({
        importPorts: {} as never,
        search: (_input, permit) =>
          permit.pipe(
            Effect.andThen(Effect.suspend(() => duringSearch)),
            Effect.as({
              items: [{ status: "active", payload: { text: "Owner memory: payroll vendor." } }],
              projectionWatermark: 0,
              nextCursor: null,
            } as never),
          ),
      }),
      Layer.mock(MemorySyncService.MemorySyncService)({
        readLocalReadiness: () =>
          Effect.succeed({ memorySpaceId: "space:test" as never, bootstrap: "ready" as const }),
      }),
    );
    const harness = makeHarness({ memoryLayer });
    const passes: Array<ChannelReceptionInput> = [];
    harness.script.current = (input) => {
      if (input.mode !== "input") return defaultScript(input);
      passes.push(input);
      return input.readsAllowed === true
        ? Effect.succeed({
            replyText: "",
            action: {
              type: "read" as const,
              reads: [{ kind: "memory" as const, query: "vendor" }],
            },
          })
        : Effect.succeed({ replyText: "Done.", action: { type: "report_only" as const } });
    };
    return Effect.gen(function* () {
      yield* setupBot;
      yield* createOwnerThread;
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const memoryOwner = {
        ...owner,
        grantedScopes: [...owner.grantedScopes, "memory:read" as const],
      };
      const { code } = yield* identities.createLink(
        { connectionId: "slack-1", runtimeModeCeiling: "auto-accept-edits" },
        memoryOwner,
      );
      const context = { ...slackContext, grantedScopes: memoryOwner.grantedScopes };
      yield* gateway.linkIdentity(
        {
          connectionId: "slack-1",
          externalActorId: "U1",
          code,
          idempotencyKey: "link-U1",
          replyAddress: slackInput("", "unused").replyAddress,
        },
        context,
      );
      const services = yield* Effect.context<ChannelIdentityService.ChannelIdentityService>();
      duringSearch = identities
        .unlink({ connectionId: "slack-1", externalActorId: "U1" })
        .pipe(Effect.provide(services), Effect.orDie);
      yield* gateway.ingest(slackInput("who is the payroll vendor?", "Ev-mem"), context);
      yield* runtime.drain;
      assert.strictEqual(passes.length, 2);
      assert.include(JSON.stringify(passes[0]?.recentThreads), "Fix the release pipeline");
      assert.notInclude(JSON.stringify(passes[1]), "payroll vendor.");
      assert.notInclude(JSON.stringify(passes[1]), "Fix the release pipeline");
    }).pipe(Effect.provide(harness.layer));
  });
});
