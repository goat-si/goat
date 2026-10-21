import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  OrchestratorMcpFailure,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DecisionRequestInput,
  type OrchestratorMcpPendingRequestRespondInput,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Profiles from "./PermissionProfiles.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Inbox from "./DecisionInbox.ts";

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const owner: Inbox.DecisionCaller = {
  kind: "client",
  sessionId: "owner",
  environmentId: EnvironmentId.make("test"),
  scopes: ["orchestration:operate", "settings:write"],
};
const agent: Inbox.DecisionCaller = {
  kind: "agent",
  scope: {
    environmentId: EnvironmentId.make("test"),
    issuedAt: 0,
    requestNamespace: "agent",
    capabilities: new Set(["orchestration"]),
    client: undefined,
    thread: {
      threadId: ThreadId.make("asking"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
  },
};
const request: DecisionRequestInput = {
  title: "Choose placement",
  context: "The primary device is unavailable.",
  options: [
    { id: "wait", label: "Wait", consequence: "Work stays paused." },
    { id: "fallback", label: "Use fallback", consequence: "Work runs on the configured fallback." },
  ],
  recommended: "wait",
  requiredProfile: "manager",
};
const fixture = (
  options: {
    readonly profile?: string;
    readonly threads?: Layer.Layer<ThreadManagement.ThreadManagementService>;
    readonly pending?: Layer.Layer<
      PendingQuestions.PendingQuestionsMcpService,
      never,
      SqlClient.SqlClient
    >;
  } = {},
) =>
  Inbox.layer.pipe(
    Layer.provide(Profiles.layer),
    Layer.provide(options.threads ?? Layer.mock(ThreadManagement.ThreadManagementService)({})),
    Layer.provide(options.pending ?? Layer.mock(PendingQuestions.PendingQuestionsMcpService)({})),
    Layer.provideMerge(
      Settings.layerTest({
        goatclaw: { enabled: true, defaultProfile: options.profile ?? "worker" },
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(NodeCrypto.layer),
  );
const pendingUsingSql = (
  respond: (
    sql: SqlClient.SqlClient,
  ) => PendingQuestions.PendingQuestionsMcpService["Service"]["respond"],
) =>
  Layer.unwrap(
    Effect.map(SqlClient.SqlClient, (sql) =>
      Layer.mock(PendingQuestions.PendingQuestionsMcpService)({ respond: respond(sql) }),
    ),
  );
const seedThread = (id = "asking", mode = "full-access") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${id}, 'project', 'Asking thread', 'codex', ${mode}, 'default', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '{}')`;
  });
const seedPending = (kind = "user_input", mode = "full-access") =>
  Effect.gen(function* () {
    yield* seedThread("pending-thread", mode);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
    (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
    VALUES ('question', 'pending-thread', 'node', ${kind}, 'pending', '1970-01-01T00:00:00.000Z', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
    (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
    VALUES ('item', 'pending-thread', 0, ${kind === "user_input" ? "user_input_request" : "approval_request"}, 'pending', '1970-01-01T00:00:00.000Z', ${JSON.stringify(
      kind === "user_input"
        ? {
            requestId: "question",
            questions: [
              {
                id: "q",
                header: "Placement",
                question: "Where should work run?",
                options: [{ label: "Wait", description: "Keep paused" }],
              },
            ],
          }
        : { requestId: "question", prompt: "Allow the command?" },
    )})`;
  });

it.effect(
  "creates, gets, answers once and stores append-only audit metadata without context or answers",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.DecisionInbox;
      const item = yield* inbox.create(owner, request);
      expect(item).toMatchObject({ status: "open", answer: null, recommended: "wait" });
      expect((yield* inbox.list(owner, { status: "open" })).items.map((item) => item.id)).toEqual([
        item.id,
      ]);
      expect(yield* inbox.get(owner, item.id)).toEqual(item);
      expect(
        yield* inbox.answer(owner, { id: item.id, optionId: "wait", reason: "Keep work paused." }),
      ).toMatchObject({ status: "answered", answer: "wait", answeredBy: "client:owner" });
      expect(
        (yield* Effect.flip(
          inbox.answer(owner, { id: item.id, optionId: "fallback", reason: "Try again" }),
        )).code,
      ).toBe("invalid_request");
      expect((yield* inbox.list(owner, { status: "open" })).items).toEqual([]);
      const sql = yield* SqlClient.SqlClient;
      const audit = yield* sql`SELECT * FROM audit_events ORDER BY id`;
      expect(audit).toHaveLength(2);
      expect(audit.map((row) => row.action)).toEqual(["decision.request", "decision.answer"]);
      expect(JSON.stringify(audit)).not.toContain(request.context);
      expect(JSON.stringify(audit)).not.toContain("Keep work paused");
      expect(yield* sql`UPDATE audit_events SET outcome = 'changed'`.pipe(Effect.isFailure)).toBe(
        true,
      );
      expect(yield* sql`DELETE FROM audit_events`.pipe(Effect.isFailure)).toBe(true);
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "rejects unknown options, duplicate ids, missing profiles, invalid recommendations and past expiry",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.DecisionInbox;
      for (const input of [
        { ...request, options: [request.options[0]!, request.options[0]!] },
        { ...request, requiredProfile: "missing" },
        { ...request, recommended: "missing" },
        { ...request, expiresAt: "1970-01-01T00:00:00.000Z" },
      ])
        expect((yield* Effect.flip(inbox.create(owner, input))).code).toBe("invalid_request");
      const item = yield* inbox.create(owner, request);
      expect(
        (yield* Effect.flip(
          inbox.answer(owner, { id: item.id, optionId: "missing", reason: "Invalid" }),
        )).code,
      ).toBe("invalid_request");
      expect((yield* inbox.get(owner, item.id)).status).toBe("open");
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "uses D1 effective profiles, rejects a worker, accepts a manager and lets the owner answer",
  () =>
    Effect.gen(function* () {
      yield* seedThread();
      const inbox = yield* Inbox.DecisionInbox;
      const item = yield* inbox.create(owner, request);
      expect(
        (yield* Effect.flip(
          inbox.answer(agent, { id: item.id, optionId: "wait", reason: "Worker" }),
        )).code,
      ).toBe("capability_denied");
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ goatclaw: { defaultProfile: "manager" } });
      expect(
        (yield* inbox.answer(agent, { id: item.id, optionId: "wait", reason: "Manager" })).status,
      ).toBe("answered");
      const ownerOnly = yield* inbox.create(owner, { ...request, requiredProfile: "owner" });
      expect(
        (yield* Effect.flip(
          inbox.answer(agent, { id: ownerOnly.id, optionId: "wait", reason: "Manager" }),
        )).code,
      ).toBe("capability_denied");
      expect(
        (yield* inbox.answer(owner, { id: ownerOnly.id, optionId: "wait", reason: "Owner" }))
          .status,
      ).toBe("answered");
    }).pipe(Effect.provide(fixture())),
);

it.effect("a read-only caller cannot request or answer, and an observer cannot request", () =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.DecisionInbox;
    const readOnly = { ...owner, scopes: ["orchestration:read"] } satisfies Inbox.DecisionCaller;
    const item = yield* inbox.create(owner, request);
    expect((yield* Effect.flip(inbox.create(readOnly, request))).code).toBe("capability_denied");
    expect(
      (yield* Effect.flip(
        inbox.answer(readOnly, { id: item.id, optionId: "wait", reason: "Read only" }),
      )).code,
    ).toBe("capability_denied");
    yield* seedThread();
    yield* (yield* Settings.ServerSettingsService).updateSettings({
      goatclaw: { defaultProfile: "observer" },
    });
    expect((yield* Effect.flip(inbox.create(agent, request))).code).toBe("capability_denied");
  }).pipe(Effect.provide(fixture())),
);

it.effect("only the asking thread or owner can withdraw; withdrawal is terminal", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const inbox = yield* Inbox.DecisionInbox;
    const item = yield* inbox.create(agent, request);
    const other = { ...owner, scopes: ["orchestration:operate"] } satisfies Inbox.DecisionCaller;
    expect((yield* Effect.flip(inbox.withdraw(other, item.id))).code).toBe("capability_denied");
    expect((yield* inbox.withdraw(agent, item.id)).status).toBe("withdrawn");
    expect(
      (yield* Effect.flip(
        inbox.answer(owner, { id: item.id, optionId: "wait", reason: "Too late" }),
      )).code,
    ).toBe("invalid_request");
  }).pipe(Effect.provide(fixture())),
);

it.effect(
  "expires on the shared scheduler with TestClock and never selects the recommendation",
  () =>
    Effect.gen(function* () {
      const receipts = yield* Queue.unbounded<void>();
      // A source registration exercises the production Scheduler, with receipts after its completed sweep.
      const inboxLayer = fixture();
      yield* Effect.gen(function* () {
        const inbox = yield* Inbox.DecisionInbox;
        const scheduler = yield* Scheduler.Scheduler;
        const expiresAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: 5 }));
        const item = yield* inbox.create(owner, { ...request, expiresAt });
        yield* scheduler.register(
          "decision-test",
          inbox.runDueWork.pipe(Effect.andThen(Queue.offer(receipts, undefined)), Effect.asVoid),
        );
        yield* Queue.take(receipts);
        yield* TestClock.adjust("5 seconds");
        yield* Queue.take(receipts);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT status, answer FROM decision_items WHERE id = ${item.id}`;
        expect(rows).toEqual([{ status: "expired", answer: null }]);
        expect(
          (yield* Effect.flip(
            inbox.answer(owner, { id: item.id, optionId: "wait", reason: "Late" }),
          )).code,
        ).toBe("invalid_request");
      }).pipe(Effect.provide(Scheduler.layer), Effect.provide(inboxLayer));
    }).pipe(Effect.scoped),
);

it.effect(
  "projects pending questions without copying them, routes answers to the existing respond path and refuses agents on human-only items",
  () =>
    Effect.gen(function* () {
      const responses = yield* Ref.make<ReadonlyArray<OrchestratorMcpPendingRequestRespondInput>>(
        [],
      );
      yield* Effect.gen(function* () {
        yield* seedPending();
        yield* seedThread();
        const inbox = yield* Inbox.DecisionInbox;
        const projected = (yield* inbox.list(owner, { status: "open" })).items[0]!;
        expect(projected).toMatchObject({
          source: "pending_request",
          title: "Placement",
          pending: { requestId: "question" },
          options: [{ label: "Wait" }],
        });
        expect((yield* inbox.get(agent, projected.id)).humanRequired).toBe(true);
        expect(
          (yield* Effect.flip(
            inbox.answer(agent, { id: projected.id, answers: { q: "Wait" }, reason: "Agent" }),
          )).code,
        ).toBe("capability_denied");
        expect(
          (yield* inbox.answer(owner, {
            id: projected.id,
            answers: { q: "Wait" },
            reason: "Owner",
          })).status,
        ).toBe("answered");
        expect(yield* Ref.get(responses)).toEqual([
          {
            threadId: "pending-thread",
            requestId: "question",
            answers: { q: "Wait" },
            reason: "Owner",
          },
        ]);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT id FROM decision_items`).toEqual([]);
        expect((yield* Effect.flip(inbox.withdraw(owner, projected.id))).code).toBe(
          "invalid_request",
        );
      }).pipe(
        Effect.provide(
          fixture({
            pending: Layer.mock(PendingQuestions.PendingQuestionsMcpService)({
              respond: (_scope, input) =>
                Ref.update(responses, (items) => [...items, input]).pipe(
                  Effect.as({ sequence: 1 }),
                ),
            }),
          }),
        ),
      );
    }),
);

it.effect("projects approvals as human-only even for an owner-profile MCP caller", () =>
  Effect.gen(function* () {
    yield* seedPending("command");
    yield* seedThread();
    const inbox = yield* Inbox.DecisionInbox;
    const item = (yield* inbox.list(agent, {})).items[0]!;
    expect(item).toMatchObject({ humanRequired: true, pending: { approval: { kind: "command" } } });
    expect(
      (yield* Effect.flip(
        inbox.answer(agent, { id: item.id, decision: "accept", reason: "Agent" }),
      )).code,
    ).toBe("capability_denied");
  }).pipe(Effect.provide(fixture({ profile: "owner" }))),
);

it.effect(
  "persists delivery before sending and retries the same message id after a transient failure",
  () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make<ReadonlyArray<ThreadManagement.ThreadManagementSendInput>>(
        [],
      );
      const fail = yield* Ref.make(true);
      yield* Effect.gen(function* () {
        yield* seedThread();
        const inbox = yield* Inbox.DecisionInbox;
        const item = yield* inbox.create(agent, request);
        yield* inbox.answer(owner, { id: item.id, optionId: "wait", reason: "Chosen" });
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* sql`SELECT delivered_at FROM decision_answer_deliveries`)[0]!.delivered_at,
        ).toBeNull();
        yield* Ref.set(fail, false);
        yield* inbox.runDueWork;
        const sent = yield* Ref.get(attempts);
        expect(sent).toHaveLength(2);
        expect(sent[0]!.messageId).toBe(sent[1]!.messageId);
        expect(sent[0]!.commandId).toBe(sent[1]!.commandId);
        expect(sent[1]!.text).toContain("Answer: Wait");
        expect(
          (yield* sql`SELECT delivered_at FROM decision_answer_deliveries`)[0]!.delivered_at,
        ).not.toBeNull();
        yield* inbox.runDueWork;
        expect(yield* Ref.get(attempts)).toHaveLength(2);
      }).pipe(
        Effect.provide(
          fixture({
            threads: Layer.mock(ThreadManagement.ThreadManagementService)({
              sendToThread: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(attempts, (items) => [...items, input]);
                  if (yield* Ref.get(fail))
                    return yield* new ThreadManagement.ThreadManagementThreadNotFoundError({
                      projectId: input.projectId,
                      threadId: input.threadId,
                    });
                  // The inbox uses only successful delivery, not the thread send result payload.
                  return {} as never;
                }),
            }),
          }),
        ),
      );
    }),
);

it.effect("carries the effective dispatch ceiling when a pending target's modes change", () =>
  Effect.gen(function* () {
    yield* seedPending("user_input", "auto");
    yield* seedThread();
    const inbox = yield* Inbox.DecisionInbox;
    const item = (yield* inbox.list(agent, {})).items[0]!;
    expect(item.humanRequired).toBe(false);
    expect(
      (yield* Effect.flip(
        inbox.answer(agent, { id: item.id, answers: { q: "Wait" }, reason: "Within ceiling" }),
      )).code,
    ).toBe("capability_denied");
  }).pipe(
    Effect.provide(
      fixture({
        pending: pendingUsingSql(
          (sql) => () =>
            Effect.gen(function* () {
              yield* sql`UPDATE orchestration_v2_projection_threads SET runtime_mode = 'full-access' WHERE thread_id = 'pending-thread'`;
              const limit = yield* DispatchModeLimit;
              expect(limit).toMatchObject({ runtimeMode: "auto", interactionMode: "default" });
              if (
                limit !== undefined &&
                exceededDispatchModeLimit(limit, {
                  runtimeMode: "full-access",
                  interactionMode: "default",
                }) !== undefined
              )
                return yield* new OrchestratorMcpFailure({
                  code: "capability_denied",
                  message: "Target modes changed before dispatch.",
                });
              return { sequence: 1 };
            }).pipe(
              Effect.mapError((error) =>
                isMcpFailure(error)
                  ? error
                  : new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: "Fixture storage failed.",
                    }),
              ),
            ),
        ),
      }),
    ),
  ),
);

it.effect(
  "reconciles a projected answer audit from its committed command receipt after interruption",
  () =>
    Effect.gen(function* () {
      yield* seedPending();
      const inbox = yield* Inbox.DecisionInbox;
      const item = (yield* inbox.list(owner, {})).items[0]!;
      yield* inbox
        .answer(owner, { id: item.id, answers: { q: "Wait" }, reason: "Chosen" })
        .pipe(Effect.flip);
      const sql = yield* SqlClient.SqlClient;
      expect((yield* sql`SELECT outcome FROM audit_events`).map((row) => row.outcome)).toEqual([
        "requested",
      ]);
      yield* inbox.runDueWork;
      yield* inbox.runDueWork;
      expect(
        (yield* sql`SELECT outcome FROM audit_events ORDER BY id`).map((row) => row.outcome),
      ).toEqual(["requested", "answered"]);
    }).pipe(
      Effect.provide(
        fixture({
          pending: pendingUsingSql(
            (sql) => (_scope, _input, commandId) =>
              Effect.gen(function* () {
                yield* sql`INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status)
      VALUES (${commandId!}, 'thread', 'pending-thread', 'runtime-request.respond', '1970-01-01T00:00:00.000Z', 1, 'accepted')`;
                return yield* new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "Simulated interruption after commit.",
                });
              }).pipe(
                Effect.mapError((error) =>
                  isMcpFailure(error)
                    ? error
                    : new OrchestratorMcpFailure({
                        code: "orchestration_error",
                        message: "Fixture storage failed.",
                      }),
                ),
              ),
          ),
        }),
      ),
    ),
);

it.effect("a failed target cannot block delivery to another asking thread", () =>
  Effect.gen(function* () {
    const deliveries = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      yield* seedThread();
      const inbox = yield* Inbox.DecisionInbox;
      const first = yield* inbox.create(agent, request);
      yield* inbox.answer(owner, { id: first.id, optionId: "wait", reason: "Chosen" });
      const second = yield* inbox.create(agent, request);
      yield* inbox.answer(owner, { id: second.id, optionId: "wait", reason: "Chosen" });
      const sql = yield* SqlClient.SqlClient;
      expect(
        (yield* sql`SELECT delivered_at FROM decision_answer_deliveries WHERE decision_id = ${first.id}`)[0]!
          .delivered_at,
      ).toBeNull();
      expect(
        (yield* sql`SELECT delivered_at FROM decision_answer_deliveries WHERE decision_id = ${second.id}`)[0]!
          .delivered_at,
      ).not.toBeNull();
    }).pipe(
      Effect.provide(
        fixture({
          threads: Layer.mock(ThreadManagement.ThreadManagementService)({
            sendToThread: (input) =>
              Effect.gen(function* () {
                const sent = yield* Ref.get(deliveries);
                yield* Ref.update(deliveries, (values) => [...values, input.messageId]);
                if (sent.length === 0 || input.messageId === sent[0])
                  return yield* new ThreadManagement.ThreadManagementThreadNotFoundError({
                    projectId: input.projectId,
                    threadId: input.threadId,
                  });
                return {} as never;
              }),
          }),
        }),
      ),
    );
  }),
);

it.effect("concurrent answers commit exactly one choice and one successful audit event", () =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.DecisionInbox;
    const item = yield* inbox.create(owner, request);
    const answers = yield* Effect.all(
      [
        inbox.answer(owner, { id: item.id, optionId: "wait", reason: "First" }).pipe(Effect.result),
        inbox
          .answer(owner, { id: item.id, optionId: "fallback", reason: "Second" })
          .pipe(Effect.result),
      ],
      { concurrency: 2 },
    );
    expect(answers.filter((result) => result._tag === "Success")).toHaveLength(1);
    const sql = yield* SqlClient.SqlClient;
    expect(
      yield* sql`SELECT id FROM audit_events WHERE action = 'decision.answer' AND outcome = 'answered'`,
    ).toHaveLength(1);
  }).pipe(Effect.provide(fixture())),
);

it.effect("rotates failing delivery batches so the 101st answer can be delivered", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (let index = 0; index < 101; index += 1) {
          const id = `decision:${String(index).padStart(3, "0")}`;
          yield* sql`INSERT INTO decision_items
        (id, from_thread_id, title, context, options_json, required_profile, status, answer, answered_by, created_at, updated_at)
        VALUES (${id}, 'asking', 'Placement', '', ${JSON.stringify(request.options)}, 'manager', 'answered', 'wait', 'client:owner', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`;
          yield* sql`INSERT INTO decision_answer_deliveries (decision_id) VALUES (${id})`;
        }
      }),
    );
    const inbox = yield* Inbox.DecisionInbox;
    yield* inbox.runDueWork;
    expect(
      (yield* sql`SELECT delivered_at FROM decision_answer_deliveries WHERE decision_id = 'decision:100'`)[0]!
        .delivered_at,
    ).toBeNull();
    yield* TestClock.adjust("5 seconds");
    yield* inbox.runDueWork;
    expect(
      (yield* sql`SELECT delivered_at FROM decision_answer_deliveries WHERE decision_id = 'decision:100'`)[0]!
        .delivered_at,
    ).not.toBeNull();
  }).pipe(
    Effect.provide(
      fixture({
        threads: Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: (input) =>
            input.messageId.endsWith("decision:100")
              ? Effect.succeed({} as never)
              : Effect.fail(
                  new ThreadManagement.ThreadManagementThreadNotFoundError({
                    projectId: input.projectId,
                    threadId: input.threadId,
                  }),
                ),
        }),
      }),
    ),
  ),
);
