import { expect, it } from "@effect/vitest";
import {
  OrchestratorMcpFailure,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DecisionRequestInput,
  type PermissionProfile,
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
import * as Settings from "../serverSettings.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Inbox from "./DecisionInbox.ts";
import {
  narrowCeiling,
  origin,
  fixture,
  pendingUsingSql,
  seedDestination,
  seedPending,
  seedThread,
  transport,
} from "./DecisionDestination.testkit.ts";

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

it.effect.each(["full-access", "auto"] as const)(
  "#1405 preservation: disabled policy respects the actual %s calling thread",
  (runtimeMode) =>
    Effect.gen(function* () {
      yield* seedThread("asking", runtimeMode);
      yield* (yield* Settings.ServerSettingsService).updateSettings({
        goatclaw: { enabled: false },
      });
      const inbox = yield* Inbox.DecisionInbox;
      const item = yield* inbox.create(owner, request);
      const result = yield* inbox
        .answer(agent, { id: item.id, optionId: "wait", reason: "Use actual thread authority" })
        .pipe(Effect.result);
      expect(result._tag).toBe(runtimeMode === "full-access" ? "Success" : "Failure");
      expect((yield* inbox.get(owner, item.id)).status).toBe(
        runtimeMode === "full-access" ? "answered" : "open",
      );
    }).pipe(Effect.provide(fixture({ profile: "manager" }))),
);

it.effect(
  "#1405 preservation: destination commits and delivers once without mutating the origin",
  () =>
    Effect.gen(function* () {
      const originInbox = yield* Inbox.DecisionInbox;
      const originSql = yield* SqlClient.SqlClient;
      const original = yield* originInbox.create(owner, request);
      const originRows = yield* originSql`SELECT * FROM decision_items`;
      const originAudits = yield* originSql`SELECT * FROM audit_events`;
      const delivered = yield* Ref.make<ReadonlyArray<ThreadManagement.ThreadManagementSendInput>>(
        [],
      );
      yield* Effect.gen(function* () {
        yield* seedThread();
        const inbox = yield* Inbox.DecisionInbox;
        const sql = yield* SqlClient.SqlClient;
        const item = yield* inbox.create(agent, request);
        yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, client_label, issued_at, expires_at)
        VALUES ('remote-session', 'mcp-client', '[]', 'bearer-access-token', 'Destination manager', '1970-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`;
        const controls = { transportEnvironmentId: origin };
        const answered = yield* inbox.answer(transport, {
          ...controls,
          id: item.id,
          optionId: "wait",
          reason: "Confirmed remotely",
        });
        expect(answered).toMatchObject({
          status: "answered",
          answeredBy: "mcp:remote-session",
          answeredByLabel: "Destination manager",
          from: { environmentId: "test" },
        });
        expect(yield* inbox.get(transport, item.id, controls)).toEqual(answered);
        expect(
          (yield* inbox.list(transport, { ...controls, localOnly: true, status: "answered" }))
            .items,
        ).toEqual([answered]);
        expect(
          yield* inbox
            .answer(transport, {
              ...controls,
              id: item.id,
              optionId: "fallback",
              reason: "Repeated",
            })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } });
        yield* inbox.runDueWork;
        yield* inbox.runDueWork;
        expect(
          yield* sql`SELECT actor FROM audit_events WHERE action = 'decision.answer' AND outcome = 'answered'`,
        ).toEqual([{ actor: "mcp:remote-session" }]);
        expect(
          yield* sql`SELECT decision_id FROM decision_answer_deliveries WHERE delivered_at IS NOT NULL`,
        ).toEqual([{ decision_id: item.id }]);
        const messages = yield* Ref.get(delivered);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          commandId: `decision-answer:${item.id}`,
          messageId: `decision-answer:${item.id}`,
        });
        expect(messages[0]!.text).toContain("Answered by: Destination manager");
      }).pipe(
        Effect.provide(
          Layer.fresh(
            fixture({
              profile: "manager",
              threads: Layer.mock(ThreadManagement.ThreadManagementService)({
                sendToThread: (input) =>
                  Ref.update(delivered, (all) => [...all, input]).pipe(Effect.as({} as never)),
              }),
            }),
          ),
        ),
      );
      expect(yield* originSql`SELECT * FROM decision_items`).toEqual(originRows);
      expect(yield* originSql`SELECT * FROM audit_events`).toEqual(originAudits);
      expect(yield* originSql`SELECT * FROM decision_answer_deliveries`).toEqual([]);
      expect(yield* originInbox.get(owner, original.id)).toEqual(original);
    }).pipe(Effect.provide(fixture({ profile: "manager" }))),
);

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
      ).toMatchObject({ status: "answered", answer: "wait", answeredBy: "You" });
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
      }).pipe(Effect.provide(Layer.merge(Scheduler.layer, inboxLayer)));
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
        expect(sent[1]!.text).toContain("Answered by: a paired client");
        expect(sent[1]!.text).not.toContain("client:owner");
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

it.effect(
  "shows viewer-relative responder labels to clients while retaining audit and MCP actors",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.DecisionInbox;
      const item = yield* inbox.create(owner, request);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, client_label, issued_at, expires_at)
    VALUES ('owner', 'owner', '[]', 'bearer-access-token', 'Office tablet', '1970-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`;
      const answered = yield* inbox.answer(owner, {
        id: item.id,
        optionId: "wait",
        reason: "Keep paused",
      });
      expect(answered.answeredBy).toBe("You");
      expect((yield* inbox.get(owner, item.id)).answeredBy).toBe("You");
      expect((yield* inbox.list(owner, { status: "answered" })).items[0]!.answeredBy).toBe("You");
      const viewer = { ...owner, sessionId: "other-client" } satisfies Inbox.DecisionCaller;
      expect((yield* inbox.get(viewer, item.id)).answeredBy).toBe("Office tablet");
      expect((yield* inbox.list(viewer, { status: "answered" })).items[0]!.answeredBy).toBe(
        "Office tablet",
      );
      yield* sql`UPDATE auth_sessions SET client_label = NULL WHERE session_id = 'owner'`;
      expect((yield* inbox.get(viewer, item.id)).answeredBy).toBe("a paired client");
      yield* sql`DELETE FROM auth_sessions WHERE session_id = 'owner'`;
      expect((yield* inbox.list(viewer, {})).items[0]!.answeredBy).toBe("a paired client");
      yield* seedThread();
      expect((yield* inbox.get(agent, item.id)).answeredBy).toBe("client:owner");
      expect((yield* inbox.list(agent, { status: "answered" })).items[0]!.answeredBy).toBe(
        "client:owner",
      );
      expect(
        (yield* sql`SELECT answered_by FROM decision_items WHERE id = ${item.id}`)[0]!.answered_by,
      ).toBe("client:owner");
      expect(
        (yield* sql`SELECT actor FROM audit_events WHERE action = 'decision.answer'`)[0]!.actor,
      ).toBe("client:owner");
    }).pipe(Effect.provide(fixture())),
);

it.effect("uses an answering agent's thread title instead of its id in client history", () =>
  Effect.gen(function* () {
    yield* seedThread();
    const inbox = yield* Inbox.DecisionInbox;
    const item = yield* inbox.create(owner, request);
    expect(
      (yield* inbox.answer(agent, { id: item.id, optionId: "wait", reason: "Within profile" }))
        .answeredBy,
    ).toBe("thread:asking");
    expect((yield* inbox.get(owner, item.id)).answeredBy).toBe("Asking thread");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_threads SET title = '' WHERE thread_id = 'asking'`;
    expect((yield* inbox.get(owner, item.id)).answeredBy).toBe("an agent");
  }).pipe(Effect.provide(fixture({ profile: "manager" }))),
);

it.effect(
  "#1405 baseline-failing: foreign discovery filters durable and pending rows before limiting",
  () =>
    Effect.gen(function* () {
      for (const input of [
        { id: "owned-a", launcherEnvironmentId: origin, launcherThreadId: "manager-a" },
        { id: "owned-b", launcherEnvironmentId: origin, launcherThreadId: "manager-b" },
        { id: "aaa-unrelated", launcherEnvironmentId: "another-origin" },
        { id: "aaa-local" },
        { id: "aaa-deleted", launcherEnvironmentId: origin, deleted: true },
        { id: "archived", launcherEnvironmentId: origin, archived: true },
        { id: "native", launcherEnvironmentId: origin, providerNative: true },
        { id: "grandchild", launcherEnvironmentId: "test", launcherThreadId: "owned-a" },
      ])
        yield* seedDestination(input);
      const inbox = yield* Inbox.DecisionInbox;
      const threadless = yield* inbox.create(owner, request);
      const input = { launcherEnvironmentId: origin, status: "open" as const };
      const items = (yield* inbox.list(transport, input)).items;
      expect(items.map((item) => item.id).sort()).toEqual([
        "decision:archived",
        "decision:native",
        "decision:owned-a",
        "decision:owned-b",
        "pending:owned-a:question-owned-a",
        "pending:owned-b:question-owned-b",
      ]);
      expect(items.every((item) => item.from.host === undefined)).toBe(true);
      expect(items.some((item) => item.id === threadless.id)).toBe(false);
      const narrowed = yield* inbox.list(transport, {
        ...input,
        launcherThreadId: ThreadId.make("manager-b"),
      });
      expect(narrowed.items.map((item) => item.id).sort()).toEqual([
        "decision:owned-b",
        "pending:owned-b:question-owned-b",
      ]);
      expect(
        (yield* inbox.list(transport, { ...input, limit: 1 })).items.map((item) => item.id),
      ).toEqual(["decision:archived"]);
    }).pipe(Effect.provide(fixture({ profile: "manager" }))),
);

it.effect.each([
  ["thread caller", agent, { launcherEnvironmentId: origin }],
  ["person caller", owner, { launcherEnvironmentId: origin }],
  [
    "unauthenticated outside caller",
    { ...transport, scope: { ...transport.scope, client: undefined } },
    { launcherEnvironmentId: origin },
  ],
  ["same environment", transport, { launcherEnvironmentId: EnvironmentId.make("test") }],
  ["thread without environment", transport, { launcherThreadId: ThreadId.make("manager-a") }],
  ["routed foreign filter", transport, { launcherEnvironmentId: origin, host: "other-host" }],
  ["fanout foreign filter", transport, { launcherEnvironmentId: origin, hosts: ["other-host"] }],
  [
    "mismatched identities",
    transport,
    { launcherEnvironmentId: origin, transportEnvironmentId: EnvironmentId.make("different") },
  ],
  ["localOnly without foreign identity", transport, { localOnly: true }],
  ["ceiling without foreign identity", transport, { permissionProfileCeiling: narrowCeiling }],
  [
    "same transport identity",
    transport,
    { localOnly: true, transportEnvironmentId: EnvironmentId.make("test") },
  ],
] as const)(
  "#1405 baseline-failing: rejects unsafe discovery controls from %s",
  ([_name, caller, input]) =>
    Effect.gen(function* () {
      yield* seedThread();
      const result = yield* (yield* Inbox.DecisionInbox).list(caller, input).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } });
    }).pipe(Effect.provide(fixture())),
);

it.effect.each(
  (
    [
      ["person", owner, origin],
      ["thread", agent, origin],
      ["missing identity", transport, undefined],
      ["same environment", transport, EnvironmentId.make("test")],
    ] as const
  ).flatMap(([name, caller, transportEnvironmentId]) =>
    (["get", "answer"] as const).map(
      (operation) =>
        [
          `${operation} rejects forwarded controls from ${name}`,
          caller,
          transportEnvironmentId,
          operation,
        ] as const,
    ),
  ),
)("#1405 baseline-failing: %s", ([_name, caller, transportEnvironmentId, operation]) =>
  Effect.gen(function* () {
    yield* seedThread();
    const inbox = yield* Inbox.DecisionInbox;
    const item = yield* inbox.create(owner, request);
    const profile = (yield* (yield* Settings.ServerSettingsService).getSettings).goatclaw.profiles
      .manager!;
    const options = {
      permissionProfileCeiling: profile,
      ...(transportEnvironmentId === undefined ? {} : { transportEnvironmentId }),
    };
    const result = yield* (
      operation === "get"
        ? inbox.get(caller, item.id, options)
        : inbox.answer(caller, {
            ...options,
            id: item.id,
            optionId: "wait",
            reason: "Invalid transport",
          })
    ).pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } });
    expect((yield* inbox.get(owner, item.id)).status).toBe("open");
  }).pipe(Effect.provide(fixture({ profile: "manager" }))),
);

it.effect.each(["list", "get"] as const)(
  "#1405 baseline-failing: forwarded %s classifies pending questions at the origin ceiling",
  (read) =>
    Effect.gen(function* () {
      yield* seedPending("user_input", "full-access");
      const inbox = yield* Inbox.DecisionInbox;
      const options = { transportEnvironmentId: origin, permissionProfileCeiling: narrowCeiling };
      const id = "pending:pending-thread:question";
      expect((yield* inbox.get(transport, id)).humanRequired).toBe(false);
      const item =
        read === "get"
          ? yield* inbox.get(transport, id, options)
          : (yield* inbox.list(transport, { ...options, localOnly: true })).items[0];
      expect(item).toMatchObject({ humanRequired: true, requiredProfile: "owner" });
      const result = yield* inbox
        .answer(transport, {
          ...options,
          id,
          answers: { q: "Wait" },
          reason: "Origin cannot resolve this",
        })
        .pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "capability_denied" } });
      expect((yield* inbox.get(owner, id)).status).toBe("open");
    }).pipe(Effect.provide(fixture({ profile: "owner" }))),
);

it.effect.each([
  ["capabilities", { capabilities: [] }],
  ["runtime", { runtimeModeCeiling: "auto" }],
  ["lanes", { maxLanes: 1 }],
  ["hosts", { hosts: ["allowed-host"] }],
  ["turns", { maxTurns: 1 }],
  ["wall-clock budget", { maxWallClockMs: 1000 }],
] satisfies ReadonlyArray<readonly [string, Partial<PermissionProfile>]>)(
  "#1405 baseline-failing: a same-named forwarded profile cannot grant broader %s",
  ([_name, change]) =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.DecisionInbox;
      const item = yield* inbox.create(owner, request);
      const manager = (yield* (yield* Settings.ServerSettingsService).getSettings).goatclaw.profiles
        .manager!;
      const input = {
        id: item.id,
        optionId: "wait",
        reason: "Narrow origin",
        transportEnvironmentId: origin,
        permissionProfileCeiling: { ...manager, ...change },
      };
      const result = yield* inbox.answer(transport, input).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "capability_denied" } });
      expect((yield* inbox.get(owner, item.id)).status).toBe("open");
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT id FROM audit_events WHERE action = 'decision.answer'`).toEqual([]);
    }).pipe(Effect.provide(fixture({ profile: "manager" }))),
);

it.effect(
  "#1405 baseline-failing: disabled policy still enforces the transport runtime ceiling",
  () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ goatclaw: { enabled: false, defaultProfile: "manager" } });
      const inbox = yield* Inbox.DecisionInbox;
      const item = yield* inbox.create(owner, request);
      const caller = {
        ...transport,
        scope: {
          ...transport.scope,
          client: { ...transport.scope.client, access: "auto" as const },
        },
      };
      const result = yield* inbox
        .answer(caller, { id: item.id, optionId: "wait", reason: "Session too narrow" })
        .pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "capability_denied" } });
      expect((yield* inbox.get(owner, item.id)).status).toBe("open");
    }).pipe(Effect.provide(fixture({ profile: "manager" }))),
);

it.effect("#1405 preservation: a transport session cannot resolve person-only questions", () =>
  Effect.gen(function* () {
    yield* seedPending("user_input", "full-access");
    const inbox = yield* Inbox.DecisionInbox;
    const caller = {
      ...transport,
      scope: {
        ...transport.scope,
        client: { ...transport.scope.client, access: "auto" as const, approvals: true },
      },
    };
    const input = {
      id: "pending:pending-thread:question",
      answers: { q: "Wait" },
      reason: "Origin person is not transported",
      transportEnvironmentId: origin,
    };
    expect(yield* inbox.answer(caller, input).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { code: "capability_denied" },
    });
    expect((yield* inbox.get(owner, input.id)).status).toBe("open");
  }).pipe(Effect.provide(fixture({ profile: "owner" }))),
);

it.effect(
  "#1405 baseline-failing: forwarded pending answers retain the execution ceiling if the target changes",
  () =>
    Effect.gen(function* () {
      yield* seedPending("user_input", "auto");
      const inbox = yield* Inbox.DecisionInbox;
      const worker = (yield* (yield* Settings.ServerSettingsService).getSettings).goatclaw.profiles
        .worker!;
      const input = {
        id: "pending:pending-thread:question",
        answers: { q: "Wait" },
        reason: "Within origin ceiling",
        transportEnvironmentId: origin,
        permissionProfileCeiling: worker,
      };
      const result = yield* inbox.answer(transport, input).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "capability_denied" } });
      expect((yield* inbox.get(owner, input.id)).status).toBe("open");
    }).pipe(
      Effect.provide(
        fixture({
          profile: "owner",
          pending: pendingUsingSql(
            (sql) => () =>
              Effect.gen(function* () {
                yield* sql`UPDATE orchestration_v2_projection_threads SET runtime_mode = 'full-access' WHERE thread_id = 'pending-thread'`;
                const limit = yield* DispatchModeLimit;
                if (
                  limit !== undefined &&
                  exceededDispatchModeLimit(limit, {
                    runtimeMode: "full-access",
                    interactionMode: "default",
                  }) !== undefined
                )
                  return yield* new OrchestratorMcpFailure({
                    code: "capability_denied",
                    message: "Target exceeds dispatch ceiling.",
                  });
                yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved' WHERE thread_id = 'pending-thread'`;
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
