import { assert, describe, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  ChannelConversationId,
  type ChannelReceptionInput,
  type ChannelReceptionReadResult,
  type ChannelRequester,
  type ChannelTask,
  ChannelTaskId,
  RunId,
  type ThreadPullRequestLink,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as MemoryService from "../memory/MemoryService.ts";
import * as MemorySyncService from "../memory/MemorySyncService.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import {
  canSeeTask,
  JOURNAL_CHARS,
  journalFor,
  matchMemoryLines,
  matchTasks,
  taskDigest,
  threadDigest,
} from "./channelBotRecall.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  makeHarness,
  onlyTask,
  owner,
  ownerId,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const conversation = ChannelConversationId.make("conversation:here");
const elsewhere = ChannelConversationId.make("conversation:elsewhere");

const person = (overrides: Partial<ChannelRequester> = {}): ChannelRequester => ({
  ownerId,
  principalId: "alice",
  displayName: "Alice",
  originKind: "slack",
  runtimeModeCeiling: "auto-accept-edits",
  grantedScopes: ["orchestration:operate"],
  ...overrides,
});

const task = (overrides: Partial<ChannelTask> = {}): ChannelTask =>
  ({
    taskId: ChannelTaskId.make("task:1"),
    conversationId: elsewhere,
    requester: person({ principalId: "bob", displayName: "Bob" }),
    title: "Fix the login page",
    instruction: "The login button does nothing on Safari.",
    status: "completed",
    version: 3,
    generation: 1,
    openQuestions: [],
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T01:00:00.000Z",
    ...overrides,
  }) as ChannelTask;

describe("who may see a task", () => {
  it("shows the conversation's own work to anyone in it, and other work by person and scope", () => {
    const bobs = task();
    assert.isTrue(canSeeTask(person(), { ...bobs, conversationId: conversation }, conversation));
    assert.isFalse(canSeeTask(person(), bobs, conversation));
    assert.isTrue(canSeeTask(person({ principalId: "bob" }), bobs, conversation));
    assert.isTrue(
      canSeeTask(
        person({ grantedScopes: ["orchestration:read", "orchestration:operate"] }),
        bobs,
        conversation,
      ),
    );
  });

  it("keeps agents to their own conversation and owners to their own work", () => {
    const agent = person({
      originKind: "mcp",
      principalId: "bob",
      grantedScopes: ["orchestration:read"],
    });
    assert.isFalse(canSeeTask(agent, task(), conversation));
    assert.isTrue(canSeeTask(agent, task({ conversationId: conversation }), conversation));
    assert.isFalse(
      canSeeTask(
        person({ ownerId: "someone-else", grantedScopes: ["orchestration:read"] }),
        task({ conversationId: conversation }),
        conversation,
      ),
    );
  });
});

describe("finding the work a question means", () => {
  const login = task();
  const docs = task({
    taskId: ChannelTaskId.make("task:2"),
    title: "Update the docs",
    instruction: "Describe the new settings page.",
    observed: {
      pullRequests: [
        {
          repository: "goat-si/goat",
          number: 457,
          url: "https://github.com/goat-si/goat/pull/457",
          state: "merged",
          watching: false,
        },
      ],
      needsYou: [],
    },
  });
  const tasks = [docs, login];

  it("matches a task id, a pull request number or URL, then shared words", () => {
    assert.deepStrictEqual(matchTasks(tasks, "task:1"), [login]);
    assert.deepStrictEqual(matchTasks(tasks, "is #457 merged?"), [docs]);
    assert.deepStrictEqual(matchTasks(tasks, "https://github.com/goat-si/goat/pull/457"), [docs]);
    assert.deepStrictEqual(matchTasks(tasks, "goat-si/goat#457"), [docs]);
    assert.deepStrictEqual(matchTasks(tasks, "what happened with the login fix"), [login]);
    assert.deepStrictEqual(matchTasks(tasks, "unrelated words"), []);
  });

  it("does not take a pull request in another repository for one with the same number", () => {
    assert.deepStrictEqual(matchTasks(tasks, "https://github.com/other/repo/pull/457"), []);
    assert.deepStrictEqual(matchTasks(tasks, "other/repo#457"), []);
  });

  it("reads a task back with its pull requests and their state", () => {
    const digest = taskDigest(docs);
    assert.include(digest, "task:2 [completed] Update the docs");
    assert.include(digest, "goat-si/goat#457 (merged)");
  });

  it("recalls a completed task's conflicting verification evidence without changing its outcome", () => {
    const completed = task({
      observed: {
        pullRequests: [],
        needsYou: [],
        result: {
          runId: RunId.make("worker-run"),
          tests: { ok: true },
          observedCheckPending: false,
          observedCheck: {
            status: "completed",
            command: "vp test run",
            exitCode: 3,
            durationMs: 1250,
            at: "2026-10-12T00:00:00.000Z",
          },
        },
      },
    });
    for (const text of [taskDigest(completed), journalFor([completed])]) {
      assert.include(text, "[completed]");
      assert.include(text, "Reported tests: passed");
      assert.include(text, "GOAT check: failed (exit 3)");
    }
  });

  it("finds memory lines sharing a word, newest first and bounded", () => {
    const lines = Array.from({ length: 30 }, (_, index) => "- deploy note " + index).join("\n");
    const found = matchMemoryLines("# header\n- prefers Korean\n" + lines, "deploy");
    assert.lengthOf(found, 12);
    assert.strictEqual(found[0], "- deploy note 29");
    assert.deepStrictEqual(matchMemoryLines("- prefers Korean", "korean"), ["- prefers Korean"]);
  });
});

describe("GOAT Bot journal", () => {
  it("lists the newest work first with results and pull requests, within its bound", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      task({
        taskId: ChannelTaskId.make("task:many-" + index),
        title: "Task " + index,
        resultSummary: "x".repeat(400),
        updatedAt: "2026-10-12T00:" + String(index).padStart(2, "0") + ":00.000Z",
      }),
    );
    const journal = journalFor(many);
    assert.isAtMost(journal.length, JOURNAL_CHARS);
    assert.isTrue(journal.startsWith("- 2026-10-12 00:39 [completed] Task 39 (for Bob): "));
    assert.notInclude(journal, "Task 0 ");
    const withPr = journalFor([
      task({
        observed: {
          pullRequests: [
            {
              repository: "goat-si/goat",
              number: 9,
              url: "https://github.com/goat-si/goat/pull/9",
              state: "merged",
              watching: false,
            },
          ],
          needsYou: [],
        },
      }),
    ]);
    assert.include(withPr, "goat-si/goat#9 (merged)");
  });

  it("searches every visible entry, not only the part a pass sees", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      task({
        taskId: ChannelTaskId.make("task:old-" + index),
        title: index === 0 ? "Rotate the staging certificate" : "Task " + index,
        resultSummary: "x".repeat(400),
        updatedAt: "2026-10-12T00:" + String(index).padStart(2, "0") + ":00.000Z",
      }),
    );
    assert.notInclude(journalFor(many), "certificate");
    const found = matchMemoryLines(journalFor(many, 200, Number.POSITIVE_INFINITY), "certificate");
    assert.lengthOf(found, 1);
  });

  it.effect("keeps the newest matching journal entries when many match", () => {
    const harness = makeHarness();
    const results: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
    harness.script.current = (input) => {
      const text = input.inputText ?? "";
      if (text.startsWith("do:")) return defaultScript(input);
      if (input.readsAllowed === true) {
        return Effect.succeed({
          replyText: "",
          action: { type: "read", reads: [{ kind: "memory", query: "deploy" }] },
        });
      }
      if (input.readResults !== undefined) results.push(input.readResults);
      return Effect.succeed({ replyText: "Okay.", action: { type: "report_only" } });
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      for (let index = 0; index < 20; index += 1) {
        yield* TestClock.adjust("1 minute");
        yield* gateway.ingest(goatInput("do: deploy service " + index, "d" + index), rpcContext);
        yield* runtime.drain;
      }
      yield* gateway.ingest(goatInput("what did I deploy?", "d-ask"), rpcContext);
      yield* runtime.drain;
      const text = results[0]![0]!.text;
      assert.include(text, "deploy service 19");
      assert.notInclude(text, "deploy service 0 ");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("reading a thread back", () => {
  it("keeps the newest messages when the result must be cut", () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      role: "assistant" as const,
      text: "message " + index + " " + "y".repeat(690),
      createdAt: "2026-10-12T00:0" + index + ":00.000Z",
    }));
    const digest = threadDigest("Login fix", messages, 2_000);
    assert.isAtMost(digest.length, 2_000);
    assert.include(digest, "message 5 ");
    assert.notInclude(digest, "message 0 ");
    // Oldest kept first, so the thread still reads in order.
    assert.isBelow(digest.indexOf("message 4 "), digest.indexOf("message 5 "));
  });
});

const mergedLink: ThreadPullRequestLink = {
  host: "github.com",
  repository: "goat-si/goat",
  number: 123,
  url: "https://github.com/goat-si/goat/pull/123",
  source: "created",
  linkedAt: "2026-10-12T00:00:00.000Z",
  snapshot: { state: "merged" } as never,
  stack: null,
};

describe("GOAT Bot reads its memory and work before answering", () => {
  it.effect("carries notes and the journal into every pass, and journals how work ended", () => {
    const harness = makeHarness();
    const seen: Array<ChannelReceptionInput> = [];
    harness.script.current = (input) => {
      if (input.mode === "input") seen.push(input);
      const text = input.inputText ?? "";
      if (text.startsWith("remember")) {
        return Effect.succeed({
          replyText: "I'll keep that.",
          action: { type: "report_only" },
          remember: "Deploys happen on Fridays.",
          rememberQuote: text,
        });
      }
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("remember deploys happen on Fridays", "m1"), rpcContext);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("do: fix the build", "m2"), rpcContext);
      yield* runtime.drain;
      const started = yield* onlyTask;
      harness.world.setStatus(started.worker!.threadId, 1, "completed", "The build is green.");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("anything new?", "m3"), rpcContext);
      yield* runtime.drain;

      const last = seen.at(-1)!;
      assert.include(last.notes ?? "", "Deploys happen on Fridays.");
      assert.include(last.journal ?? "", "[completed] fix the build (for Owner)");
      assert.isTrue(last.readsAllowed);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("answers whether a pull request merged and what its thread said, in one reply", () => {
    const harness = makeHarness();
    const results: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
    harness.script.current = (input) => {
      if (input.mode !== "input" || !(input.inputText ?? "").includes("merge")) {
        return defaultScript(input);
      }
      if (input.readsAllowed === true) {
        return Effect.succeed({
          replyText: "Checking.",
          action: {
            type: "read",
            reads: [
              { kind: "work", query: "#123" },
              { kind: "thread", query: "login fix" },
            ],
          },
        });
      }
      results.push(input.readResults ?? []);
      return Effect.succeed({ replyText: "Yes, #123 merged.", action: { type: "report_only" } });
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      yield* gateway.ingest(goatInput("do: ship the login fix", "p1"), rpcContext);
      yield* runtime.drain;
      const started = yield* onlyTask;
      const threadId = started.worker!.threadId;
      harness.world.pullRequests.set(threadId, [mergedLink]);
      harness.world.setStatus(threadId, 1, "completed", "Opened and merged the login fix.");
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const providerCallsBefore = harness.world.launches.length;

      yield* gateway.ingest(goatInput("did the login PR merge?", "p2"), rpcContext);
      yield* runtime.drain;

      assert.lengthOf(results, 1);
      const [work, thread] = results[0]!;
      assert.include(work!.text, "ship the login fix");
      assert.include(work!.text, "goat-si/goat#123 (merged)");
      assert.include(thread!.text, "Opened and merged the login fix.");
      // Reading started no worker, and the person got one reply: the answer.
      assert.strictEqual(harness.world.launches.length, providerCallsBefore);
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.strictEqual(texts.filter((text) => text === "Yes, #123 merged.").length, 1);
      assert.notInclude(texts, "Checking.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("finds older messages, including ones with quotes and wildcards, and notes", () => {
    const harness = makeHarness();
    const results: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
    harness.script.current = (input) => {
      const text = input.inputText ?? "";
      if (text.startsWith("remember")) {
        return Effect.succeed({
          replyText: "Kept.",
          action: { type: "report_only" },
          remember: "The staging password rotates monthly.",
          rememberQuote: text,
        });
      }
      if (text.startsWith("when")) {
        if (input.readsAllowed === true) {
          return Effect.succeed({
            replyText: "",
            action: {
              type: "read",
              reads: [
                { kind: "memory", query: "staging" },
                { kind: "conversation", query: '61% "lighthouse"' },
                { kind: "conversation", query: "message_json" },
                { kind: "conversation", query: "mention that score" },
              ],
            },
          });
        }
        results.push(input.readResults ?? []);
      }
      return Effect.succeed({ replyText: "Okay.", action: { type: "report_only" } });
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(
        goatInput('the score dropped to 61% "lighthouse"\nsecond line', "c1"),
        rpcContext,
      );
      yield* gateway.ingest(goatInput("remember staging rotates monthly", "c2"), rpcContext);
      yield* runtime.drain;
      yield* gateway.ingest(goatInput("when did I mention that score?", "c3"), rpcContext);
      yield* runtime.drain;
      const [memory, older, metadata, asking] = results[0]!;
      assert.include(memory!.text, "The staging password rotates monthly.");
      assert.include(older!.text, 'the score dropped to 61% "lighthouse"');
      // Only the words people wrote are searched, never the stored record around them.
      assert.strictEqual(metadata!.text, "No earlier message in this conversation matches.");
      // The question being answered is not its own history.
      assert.strictEqual(asking!.text, "No earlier message in this conversation matches.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("says it found nothing when the second pass asks to read again", () => {
    const harness = makeHarness();
    let calls = 0;
    harness.script.current = (input) => {
      if (input.mode !== "input") return defaultScript(input);
      calls += 1;
      return Effect.succeed({
        replyText: input.readsAllowed === true ? "Looking." : "",
        action: { type: "read", reads: [{ kind: "work", query: "anything" }] },
      });
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("what happened?", "r1"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(calls, 2);
      const texts = (yield* botMessages).messages.map((message) => message.text);
      assert.include(texts, CHANNEL_COPY.readFoundNothing);
      assert.notInclude(texts, "Looking.");
      assert.notInclude(texts, "Looking that up.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not show a linked person work they may not see", () => {
    const harness = makeHarness();
    const results: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
    const inputs: Array<ChannelReceptionInput> = [];
    harness.script.current = (input) => {
      if ((input.inputText ?? "").startsWith("what happened")) {
        inputs.push(input);
        if (input.readsAllowed === true) {
          return Effect.succeed({
            replyText: "",
            action: {
              type: "read",
              reads: [
                { kind: "work", query: "payroll" },
                { kind: "thread", query: "payroll" },
                { kind: "memory", query: "payroll" },
              ],
            },
          });
        }
        results.push(input.readResults ?? []);
        return Effect.succeed({ replyText: "Nothing I can see.", action: { type: "report_only" } });
      }
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      yield* gateway.ingest(goatInput("do: fix payroll export", "v1"), rpcContext);
      yield* runtime.drain;
      // A teammate, linked under their own name, who may start work but not read GOAT's threads.
      const { code } = yield* identities.createLink(
        {
          connectionId: "slack-1",
          runtimeModeCeiling: "auto-accept-edits",
          grantedScopes: ["orchestration:operate"],
        },
        { ...owner, principalId: "teammate", displayName: "Teammate" },
      );
      yield* gateway.linkIdentity(
        {
          connectionId: "slack-1",
          externalActorId: "U2",
          code,
          idempotencyKey: "link-U2",
          replyAddress: slackInput("", "unused").replyAddress,
        },
        slackContext,
      );
      yield* gateway.ingest(
        slackInput("what happened with payroll?", "Ev-v2", "1760000000.000200", "U2"),
        slackContext,
      );
      yield* runtime.drain;
      const [work, thread, memory] = results[0]!;
      assert.strictEqual(work?.text, "No work this person may see matches.");
      assert.strictEqual(thread?.text, "No work this person may see matches.");
      assert.strictEqual(memory?.text, "Nothing in memory matches.");
      // Nothing about the owner's work reaches the model by any other route either.
      for (const input of inputs) assert.notInclude(JSON.stringify(input), "payroll export");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("GOAT Bot reads GOAT memory under the asker's current link", () => {
  const searched: Array<string> = [];
  const memoryLayer = Layer.mergeAll(
    Layer.mock(MemoryService.MemoryService)({
      importPorts: {} as never,
      search: (input, permit) =>
        permit.pipe(
          Effect.andThen(Effect.sync(() => searched.push(input.query))),
          Effect.as({
            items: [{ status: "active", payload: { text: "Prefers replies in Korean." } }],
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

  const linkWith = (user: string, scopes: ReadonlyArray<AuthEnvironmentScope>) =>
    Effect.gen(function* () {
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const granting = {
        ...owner,
        grantedScopes: [...owner.grantedScopes, "memory:read"] satisfies AuthEnvironmentScope[],
      };
      const { code } = yield* identities.createLink(
        { connectionId: "slack-1", runtimeModeCeiling: "auto-accept-edits", grantedScopes: scopes },
        granting,
      );
      yield* gateway.linkIdentity(
        {
          connectionId: "slack-1",
          externalActorId: user,
          code,
          idempotencyKey: "link-" + user,
          replyAddress: slackInput("", "unused").replyAddress,
        },
        { ...slackContext, grantedScopes: granting.grantedScopes },
      );
    });

  // The Slack connection itself may read memory; each link narrows that.
  const memoryContext = {
    ...slackContext,
    grantedScopes: [...owner.grantedScopes, "memory:read"] satisfies AuthEnvironmentScope[],
  };

  it.effect("finds memory for a link that may read it and skips one that may not", () => {
    searched.length = 0;
    const harness = makeHarness({ memoryLayer });
    const results: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
    harness.script.current = (input) => {
      if (input.readsAllowed === true) {
        return Effect.succeed({
          replyText: "",
          action: { type: "read", reads: [{ kind: "memory", query: "language" }] },
        });
      }
      if (input.readResults !== undefined) results.push(input.readResults);
      return Effect.succeed({ replyText: "Okay.", action: { type: "report_only" } });
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* linkWith("U1", ["orchestration:read", "orchestration:operate", "memory:read"]);
      yield* linkWith("U2", ["orchestration:operate"]);
      yield* gateway.ingest(
        slackInput("which language do I like?", "Ev-m1", "1760000000.000300", "U1"),
        memoryContext,
      );
      yield* gateway.ingest(
        slackInput("which language do I like?", "Ev-m2", "1760000000.000400", "U2"),
        memoryContext,
      );
      yield* runtime.drain;
      assert.deepStrictEqual(searched, ["language"]);
      const texts = results.map((result) => result[0]!.text);
      assert.isTrue(texts.some((text) => text.includes("Prefers replies in Korean.")));
      assert.isTrue(texts.some((text) => text === "Nothing in memory matches."));
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("GOAT Bot judges visibility with the link as it is when it reads", () => {
  it.effect("shows nothing of others' work once the asker's link is removed", () => {
    const harness = makeHarness();
    const inputs: Array<ChannelReceptionInput> = [];
    harness.script.current = (input) => {
      if (!(input.inputText ?? "").startsWith("what happened")) return defaultScript(input);
      inputs.push(input);
      if (input.readsAllowed === true) {
        return Effect.succeed({
          replyText: "",
          action: { type: "read", reads: [{ kind: "work", query: "payroll" }] },
        });
      }
      return Effect.succeed({ replyText: "Okay.", action: { type: "report_only" } });
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: fix payroll export", "x1"), rpcContext);
      yield* runtime.drain;
      // A teammate who could read every thread when the message arrived.
      const { code } = yield* identities.createLink(
        {
          connectionId: "slack-1",
          runtimeModeCeiling: "auto-accept-edits",
          grantedScopes: ["orchestration:read", "orchestration:operate"],
        },
        { ...owner, principalId: "teammate", displayName: "Teammate" },
      );
      yield* gateway.linkIdentity(
        {
          connectionId: "slack-1",
          externalActorId: "U3",
          code,
          idempotencyKey: "link-U3",
          replyAddress: slackInput("", "unused").replyAddress,
        },
        slackContext,
      );
      yield* gateway.ingest(
        slackInput("what happened with payroll?", "Ev-x2", "1760000000.000500", "U3"),
        slackContext,
      );
      yield* ledger.unlinkIdentity({ connectionId: "slack-1", externalActorId: "U3" });
      yield* runtime.drain;
      assert.lengthOf(inputs, 2);
      for (const input of inputs) assert.notInclude(JSON.stringify(input), "payroll export");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("GOAT Bot judges the link again after its first pass", () => {
  it.effect("reads nothing hidden when the link is removed while the first pass runs", () => {
    const harness = makeHarness();
    const inputs: Array<ChannelReceptionInput> = [];
    const results: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      const ledger = yield* ChannelLedger.ChannelLedger;
      harness.script.current = (input) => {
        if (!(input.inputText ?? "").startsWith("what happened")) return defaultScript(input);
        inputs.push(input);
        if (input.readsAllowed === true) {
          // The link goes away while this pass is thinking.
          return ledger.unlinkIdentity({ connectionId: "slack-1", externalActorId: "U4" }).pipe(
            Effect.orDie,
            Effect.as({
              replyText: "",
              action: {
                type: "read" as const,
                // A query copied from what the first pass could still see.
                reads: [{ kind: "work" as const, query: "fix payroll export" }],
              },
            }),
          );
        }
        results.push(input.readResults ?? []);
        return Effect.succeed({ replyText: "Okay.", action: { type: "report_only" as const } });
      };
      yield* gateway.ingest(goatInput("do: fix payroll export", "y1"), rpcContext);
      yield* runtime.drain;
      const { code } = yield* identities.createLink(
        {
          connectionId: "slack-1",
          runtimeModeCeiling: "auto-accept-edits",
          grantedScopes: ["orchestration:read", "orchestration:operate"],
        },
        { ...owner, principalId: "teammate", displayName: "Teammate" },
      );
      yield* gateway.linkIdentity(
        {
          connectionId: "slack-1",
          externalActorId: "U4",
          code,
          idempotencyKey: "link-U4",
          replyAddress: slackInput("", "unused").replyAddress,
        },
        slackContext,
      );
      yield* gateway.ingest(
        slackInput("what happened with payroll?", "Ev-y2", "1760000000.000600", "U4"),
        slackContext,
      );
      yield* runtime.drain;
      assert.lengthOf(inputs, 2);
      // Before the unlink the teammate could see it; after, neither the reads nor the journal do.
      assert.include(inputs[0]!.journal ?? "", "payroll export");
      assert.strictEqual(results[0]![0]!.text, "No work this person may see matches.");
      assert.notInclude(JSON.stringify(inputs[1]), "payroll export");
    }).pipe(Effect.provide(harness.layer));
  });
});
