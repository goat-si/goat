import { assert, describe, it } from "@effect/vitest";
import {
  ChannelConversationId,
  type ChannelReceptionReadResult,
  type ChannelRequester,
  type ChannelTask,
  ChannelTaskId,
  EnvironmentId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import { host, initialize, withRemote } from "../sshRemote/SshRemoteDispatch.hostCall.testkit.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { RECALL_RESULT_CHARS } from "./channelBotRecall.ts";
import { makeRemoteThreadRecall, REMOTE_RECALL_TIMEOUT_MS } from "./channelRemoteRecall.ts";
import {
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

const message = (type: string, text: string, minute: number) => ({
  type,
  text,
  updatedAt: "2026-10-12T01:" + String(minute).padStart(2, "0") + ":00.000Z",
});

type Item = ReturnType<typeof message>;

/** What goat_thread_read answers for a tail read; extra fields stand in for the rest of it. */
const threadRead = (items: ReadonlyArray<Item>) => ({
  host: "devbox",
  thread: { title: "Payroll export", threadId: "thread:remote", status: "idle" },
  recentRuns: [],
  items,
  nextPosition: null,
  hasMore: false,
  tailStartPosition: items.length === 0 ? null : 40,
});

const payrollMessages = [
  message("user_message", "Fix the payroll export.", 1),
  message("assistant_message", "The CSV writer drops the last row; fixing it.", 2),
  message("assistant_message", "Fixed and pushed; the export has every row now.", 3),
];

interface FakeHost {
  answer: (
    call: SshRemoteDispatch.SshHostToolCall,
  ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
  answeredBy: EnvironmentId | undefined;
  readonly calls: Array<{ readonly call: SshRemoteDispatch.SshHostToolCall; ceiling: RuntimeMode }>;
}

/** Another machine as reception reaches it: callHostTool, answering for one environment. */
const fakeHost = () => {
  const state: FakeHost = {
    answer: () => Effect.succeed(threadRead(payrollMessages)),
    answeredBy: undefined,
    calls: [],
  };
  const layer = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
    listHosts: () => Effect.succeed([]),
    connectedHosts: Effect.succeed([]),
    callHostTool: <E, R>(
      call: SshRemoteDispatch.SshHostToolCall,
      authorize: Effect.Effect<RuntimeMode, E, R>,
    ) =>
      Effect.gen(function* () {
        const ceiling = yield* authorize;
        state.calls.push({ call, ceiling });
        const answer = yield* state.answer(call);
        call.onResolvedEnvironmentId?.(state.answeredBy ?? null);
        return answer;
      }),
  });
  return {
    state,
    layer,
    reads: () => state.calls.filter((c) => c.call.tool === "goat_thread_read"),
  };
};

/** The model asks to read the payroll thread, then answers; the read results are kept. */
const scriptPayrollQuestion = (harness: ReturnType<typeof makeHarness>) => {
  const results: Array<ReadonlyArray<ChannelReceptionReadResult>> = [];
  harness.script.current = (input) => {
    if (!(input.inputText ?? "").includes("payroll thread")) return defaultScript(input);
    if (input.readsAllowed === true)
      return Effect.succeed({
        replyText: "",
        action: { type: "read", reads: [{ kind: "thread", query: "payroll" }] },
      });
    results.push(input.readResults ?? []);
    return Effect.succeed({ replyText: "Here it is.", action: { type: "report_only" } });
  };
  return results;
};

/** A finished payroll task whose worker ran on devbox, as a remote launch records it. */
const payrollRanOnDevbox = (harness: ReturnType<typeof makeHarness>, remote: FakeHost) =>
  Effect.gen(function* () {
    yield* setupBot;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    yield* gateway.ingest(goatInput("do: fix payroll export", "r1"), rpcContext);
    yield* runtime.drain;
    const started = yield* onlyTask;
    harness.world.setStatus(started.worker!.threadId, 1, "completed", "Exported payroll.");
    yield* reports.reconcile(runtime.ownerToken);
    yield* runtime.drain;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.host', 'devbox', '$.worker.host', 'devbox')`;
    remote.answeredBy = started.worker!.environmentId;
    return { started, gateway, runtime };
  });

/** Links Slack user U2 as a teammate holding scopes. */
const linkTeammate = (scopes: ReadonlyArray<"orchestration:read" | "orchestration:operate">) =>
  Effect.gen(function* () {
    const identities = yield* ChannelIdentityService.ChannelIdentityService;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const { code } = yield* identities.createLink(
      { connectionId: "slack-1", runtimeModeCeiling: "auto-accept-edits", grantedScopes: scopes },
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
  });

describe("GOAT Bot reads a work thread on another machine", () => {
  it.effect(
    "answers with the remote thread's newest messages, asked once at the asker's ceiling",
    () => {
      const remote = fakeHost();
      const harness = makeHarness({ sshRemote: remote.layer });
      const results = scriptPayrollQuestion(harness);
      return Effect.gen(function* () {
        const { started, gateway, runtime } = yield* payrollRanOnDevbox(harness, remote.state);
        yield* gateway.ingest(goatInput("what did the payroll thread say?", "r2"), rpcContext);
        yield* runtime.drain;

        const text = results[0]?.[0]?.text ?? "";
        assert.include(text, "runs on devbox");
        assert.include(text, "result: Exported payroll.");
        assert.include(text, 'thread "Payroll export", newest 3 messages:');
        assert.include(text, "agent: Fixed and pushed; the export has every row now.");
        assert.notInclude(text, "only its reports reach this machine");
        const reads = remote.reads();
        assert.lengthOf(reads, 1);
        assert.deepInclude(reads[0]!.call, { host: "devbox", writes: false, requireReady: true });
        assert.deepStrictEqual(reads[0]!.call.arguments, {
          threadId: started.worker!.threadId,
          view: "messages",
          tail: 24,
          runLimit: 1,
          maxCharsPerItem: 701,
        });
        assert.strictEqual(reads[0]!.ceiling, started.requester.runtimeModeCeiling);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("asks the other machine nothing for a person who may not see the work", () => {
    const remote = fakeHost();
    const harness = makeHarness({ sshRemote: remote.layer });
    const results = scriptPayrollQuestion(harness);
    return Effect.gen(function* () {
      const { gateway, runtime } = yield* payrollRanOnDevbox(harness, remote.state);
      // A teammate who may start work but not read GOAT's threads.
      yield* linkTeammate(["orchestration:operate"]);
      yield* gateway.ingest(
        slackInput("what did the payroll thread say?", "Ev-r3", "1760000000.000300", "U2"),
        slackContext,
      );
      yield* runtime.drain;
      assert.strictEqual(results[0]?.[0]?.text, "No work this person may see matches.");
      assert.lengthOf(remote.reads(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("drops what the other machine said when the asker's link is removed meanwhile", () => {
    const remote = fakeHost();
    const harness = makeHarness({ sshRemote: remote.layer });
    const results = scriptPayrollQuestion(harness);
    return Effect.gen(function* () {
      const { gateway, runtime } = yield* payrollRanOnDevbox(harness, remote.state);
      yield* linkTeammate(["orchestration:read", "orchestration:operate"]);
      const ledger = yield* ChannelLedger.ChannelLedger;
      remote.state.answer = () =>
        ledger
          .unlinkIdentity({ connectionId: "slack-1", externalActorId: "U2" })
          .pipe(Effect.orDie, Effect.as(threadRead(payrollMessages)));
      yield* gateway.ingest(
        slackInput("what did the payroll thread say?", "Ev-r4", "1760000000.000400", "U2"),
        slackContext,
      );
      yield* runtime.drain;
      assert.lengthOf(remote.reads(), 1);
      assert.deepStrictEqual(results[0], []);
    }).pipe(Effect.provide(harness.layer));
  });
});

const workerEnvironment = EnvironmentId.make("environment:devbox");

const remoteTask = {
  taskId: ChannelTaskId.make("task:remote"),
  conversationId: ChannelConversationId.make("conversation:here"),
  requester: {
    ownerId,
    principalId: "alice",
    displayName: "Alice",
    originKind: "goat",
    runtimeModeCeiling: "auto-accept-edits",
    grantedScopes: [],
  },
  title: "Fix the payroll export",
  instruction: "The payroll CSV drops its last row.",
  status: "completed",
  version: 3,
  generation: 1,
  host,
  resultSummary: "Exported payroll.",
  openQuestions: [],
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T01:00:00.000Z",
} as unknown as ChannelTask;

const viewer: ChannelRequester = { ...remoteTask.requester, runtimeModeCeiling: "full-access" };

const link = (environmentId: string, token: string): LinkedHosts.LinkedHostCredential => ({
  host: {
    name: host,
    baseUrl: "https://build-box.example/",
    environmentId,
    label: "Build box",
    serverVersion: "test",
    access: "read-only",
    linkedAt: "2026-10-12T00:00:00.000Z",
    expiresAt: "2026-12-12T00:00:00.000Z",
  },
  token,
});

/**
 * One saved link that both the reader and callHostTool read, so a relink between their lookups is
 * seen by whichever looks next. afterFind runs after each of the reader's lookups.
 */
const linkStore = (initial: LinkedHosts.LinkedHostCredential) => {
  const store = { current: initial, afterFind: (_lookup: number) => {} };
  let lookups = 0;
  const credential: LinkedHosts.LinkedHostCredential = {
    get host() {
      return store.current.host;
    },
    get token() {
      return store.current.token;
    },
  };
  const layer = Layer.mock(LinkedHosts.LinkedHosts)({
    find: () =>
      Effect.sync(() => {
        const seen = { ...store.current };
        store.afterFind(lookups++);
        return Option.some(seen);
      }),
  });
  return { store, credential, layer };
};

type Answer = Parameters<typeof withRemote>[0]["answer"];

/** A host that answers the thread read with threadAnswer and names environment answeredBy. */
const answering =
  (threadAnswer: ReturnType<Answer>, answeredBy: string = workerEnvironment): Answer =>
  (request) =>
    initialize(request) ??
    (request.tool === "goat_environment_read"
      ? { result: { structuredContent: { environmentId: answeredBy } } }
      : threadAnswer);

const recallOn = (
  answer: Answer,
  options: {
    readonly hostAlias?: string;
    readonly linkedHost?: LinkedHosts.LinkedHostCredential;
    readonly links?: Layer.Layer<LinkedHosts.LinkedHosts>;
  } = {},
) =>
  withRemote(
    { answer, ...(options.linkedHost === undefined ? {} : { linkedHost: options.linkedHost }) },
    Effect.gen(function* () {
      const recall = yield* makeRemoteThreadRecall;
      return yield* recall(
        remoteTask,
        {
          host: options.hostAlias ?? host,
          threadId: ThreadId.make("thread:remote"),
          environmentId: workerEnvironment,
        },
        viewer,
      );
    }).pipe(options.links === undefined ? (effect) => effect : Effect.provide(options.links)),
  ).pipe(
    Effect.map(({ result, record }) => {
      assert.strictEqual(result._tag, "Success");
      return {
        text: result._tag === "Success" ? result.success : "",
        threadReads: record.toolCalls.filter((tool) => tool === "goat_thread_read").length,
        record,
      };
    }),
  );

const fromReports = (line: string) => line + "; this is from its reports.";

describe("a remote thread read that cannot be used", () => {
  it.effect("answers from the reports when the host does not answer in time", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();
      const fiber = yield* recallOn((request) => {
        const initial = initialize(request);
        if (initial !== undefined) return initial;
        Deferred.doneUnsafe(asked, Effect.void);
        return new Promise(() => undefined);
      }).pipe(Effect.forkChild);
      yield* Deferred.await(asked);
      yield* TestClock.adjust(REMOTE_RECALL_TIMEOUT_MS);
      const { text, threadReads } = yield* Fiber.join(fiber);
      assert.include(text, "result: Exported payroll.");
      assert.include(text, fromReports("Its thread on build-box did not answer in time"));
      assert.strictEqual(threadReads, 1);
    }),
  );

  it.effect("says why for a refusal, an older host, another environment and an unknown host", () =>
    Effect.gen(function* () {
      const cases = [
        [
          answering({ result: { isError: true, structuredContent: { message: "not yours" } } }),
          {},
          "GOAT on build-box refused to show its thread",
        ],
        // An older host that ignored tail would show the thread's oldest items as its newest.
        [
          answering({
            result: {
              structuredContent: { ...threadRead(payrollMessages), tailStartPosition: undefined },
            },
          }),
          {},
          "Its thread on build-box could not be read here",
        ],
        [
          answering(
            { result: { structuredContent: threadRead(payrollMessages) } },
            "environment:other",
          ),
          {},
          "build-box may no longer be the GOAT that ran it",
        ],
        // The thread read answers, but the host cannot then say which environment it is.
        [
          (request: Parameters<Answer>[0]) =>
            request.tool === "goat_environment_read"
              ? { status: 500 }
              : answering({ result: { structuredContent: threadRead(payrollMessages) } })(request),
          {},
          "build-box may no longer be the GOAT that ran it",
        ],
        [
          answering({ result: { structuredContent: threadRead(payrollMessages) } }),
          { hostAlias: "elsewhere" },
          "elsewhere is not connected to this machine",
        ],
      ] as const;
      for (const [answer, options, line] of cases) {
        const { text, threadReads } = yield* recallOn(answer, options);
        assert.include(text, "result: Exported payroll.");
        assert.include(text, fromReports(line));
        assert.isAtMost(threadReads, 1);
      }
    }),
  );

  it.effect("reads a linked host only while the same link names the worker's environment", () =>
    Effect.gen(function* () {
      const read = answering({ result: { structuredContent: threadRead(payrollMessages) } });
      const steady = linkStore(link(workerEnvironment, "token-a"));
      const kept = yield* recallOn(read, { linkedHost: steady.credential, links: steady.layer });
      assert.include(kept.text, "agent: Fixed and pushed; the export has every row now.");

      // Relinked to another environment right after the check, and back while B answers.
      const relinked = linkStore(link(workerEnvironment, "token-a"));
      relinked.store.afterFind = (lookup) => {
        if (lookup === 0) relinked.store.current = link("environment:other", "token-b");
      };
      const bearers: Array<string | null> = [];
      const swapped = yield* recallOn(
        (request) => {
          if (request.tool === "goat_thread_read") {
            bearers.push(request.authorization);
            relinked.store.current = link(workerEnvironment, "token-c");
          }
          return read(request);
        },
        { linkedHost: relinked.credential, links: relinked.layer },
      );
      assert.deepStrictEqual(bearers, ["Bearer token-b"]);
      assert.notInclude(swapped.text, "Fixed and pushed");
      assert.include(swapped.text, fromReports("build-box may no longer be the GOAT that ran it"));

      const other = linkStore(link("environment:other", "token-b"));
      const elsewhere = yield* recallOn(read, { linkedHost: other.credential, links: other.layer });
      assert.include(
        elsewhere.text,
        fromReports("build-box may no longer be the GOAT that ran it"),
      );
      assert.strictEqual(elsewhere.threadReads, 0);
    }),
  );

  it.effect("keeps the newest messages, skips plans, and stays within the read's size", () =>
    Effect.gen(function* () {
      const items = Array.from({ length: 60 }, (_, index) =>
        index % 3 === 0
          ? message("plan", "plan " + index, index % 60)
          : message("assistant_message", "step " + index + " " + "x".repeat(900), index % 60),
      );
      const { text } = yield* recallOn(
        answering({ result: { structuredContent: threadRead(items) } }),
      );
      assert.isAtMost(text.length, RECALL_RESULT_CHARS);
      assert.include(text, "step 59 ");
      assert.notInclude(text, "step 1 ");
      assert.notInclude(text, "plan ");
      const empty = yield* recallOn(answering({ result: { structuredContent: threadRead([]) } }));
      assert.include(empty.text, 'thread "Payroll export", newest 0 messages:');
    }),
  );
});
