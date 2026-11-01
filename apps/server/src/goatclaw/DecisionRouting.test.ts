import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  pendingDecisionId,
  type DecisionRequestInput,
  type OrchestrationV2ServerCommand,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { questionEscalationMessageId } from "../orchestration-v2/QuestionEscalationService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../serverSettings.ts";
import * as Inbox from "./DecisionInbox.ts";
import { fixture, seedThread } from "./DecisionDestination.testkit.ts";

const owner: Inbox.DecisionCaller = {
  kind: "client",
  sessionId: "owner",
  environmentId: EnvironmentId.make("test"),
  scopes: ["orchestration:operate", "settings:write"],
};
const threadCaller = (threadId: string): Inbox.DecisionCaller => ({
  kind: "agent",
  scope: {
    environmentId: EnvironmentId.make("test"),
    issuedAt: 0,
    requestNamespace: threadId,
    capabilities: new Set(["orchestration"]),
    client: undefined,
    thread: {
      threadId: ThreadId.make(threadId),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
  },
});
const child = threadCaller("child");
const parent = threadCaller("parent");
const request: DecisionRequestInput = {
  title: "Pick a database",
  context: "Both pass the tests.",
  options: [
    { id: "pg", label: "Postgres", consequence: "Needs a server." },
    { id: "sqlite", label: "SQLite", consequence: "One file." },
  ],
  requiredProfile: "manager",
};

/** A parent thread and a child it launched here, as thread.launch records them. */
const seedFamily = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* seedThread("parent");
  yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES ('child', 'project', 'Child thread', 'codex', 'full-access', 'default', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z',
      '{"launchedBy":{"kind":"launch","threadId":"parent","environmentId":null,"environmentLabel":null,"threadTitle":null}}')`;
});

/** What the orchestrator projects for an accepted queued wake. */
const projectWake = (messageId: string, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${`run:${messageId}`}, 'parent', 1, 'codex', ${status}, '1970-01-01T00:00:00.000Z', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${messageId}, 'parent', ${`run:${messageId}`}, 'user', 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '{}')`;
  });

const withDispatches = <A, E, R>(
  body: (sent: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    return yield* body(sent).pipe(
      Effect.provide(
        fixture({
          profile: "manager",
          threads: Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Ref.update(sent, (all) => [...all, command]).pipe(Effect.as({} as never)),
            sendToThread: () => Effect.succeed({} as never),
          }),
        }),
      ),
    );
  });

it.effect(
  "a launched child's decision wakes its parent once and waits for it while that wake runs",
  () =>
    withDispatches((sent) =>
      Effect.gen(function* () {
        yield* seedFamily;
        const inbox = yield* Inbox.DecisionInbox;
        const sql = yield* SqlClient.SqlClient;
        const item = yield* inbox.create(child, request);
        const wakes = yield* Ref.get(sent);
        expect(wakes).toHaveLength(1);
        expect(wakes[0]).toMatchObject({
          type: "message.dispatch",
          threadId: "parent",
          messageId: `decision-route:${item.id}:0`,
          dispatchMode: { type: "queue_after_active" },
        });
        yield* projectWake(`decision-route:${item.id}:0`, "queued");
        yield* inbox.runDueWork;
        yield* inbox.runDueWork;
        expect(yield* Ref.get(sent)).toHaveLength(1);
        const listed = (yield* inbox.list(owner, { status: "open" })).items.find(
          (entry) => entry.id === item.id,
        );
        expect(listed).toMatchObject({
          routedTo: "parent",
          from: { threadId: "child", threadTitle: "Child thread", parentThreadId: "parent" },
        });
        // The wake's run ended without an answer: the person gets it, still open.
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;
        expect(yield* inbox.get(owner, item.id)).toMatchObject({
          status: "open",
          routedTo: "person",
          from: { parentThreadId: "parent" },
        });
      }),
    ),
);

it.effect("only the parent can hand a child's decision to the person, once, while it is open", () =>
  withDispatches(() =>
    Effect.gen(function* () {
      yield* seedFamily;
      const inbox = yield* Inbox.DecisionInbox;
      const sql = yield* SqlClient.SqlClient;
      const item = yield* inbox.create(child, request);
      yield* projectWake(`decision-route:${item.id}:0`, "running");
      expect(
        (yield* Effect.flip(inbox.escalate(child, { id: item.id, reason: "Not mine" }))).code,
      ).toBe("capability_denied");
      const escalated = yield* inbox.escalate(parent, { id: item.id, reason: "Needs the user" });
      expect(escalated).toMatchObject({
        routedTo: "person",
        escalation: { by: "Asking thread", reason: "Needs the user" },
      });
      const again = yield* inbox.escalate(parent, { id: item.id, reason: "Repeated" });
      expect(again.escalation).toEqual(escalated.escalation);
      expect(
        yield* sql`SELECT actor, outcome FROM audit_events WHERE action = 'decision.escalate'`,
      ).toEqual([{ actor: "thread:parent", outcome: "person" }]);
      yield* inbox.answer(owner, { id: item.id, optionId: "sqlite", reason: "Chosen" });
      const other = yield* inbox.create(child, request);
      yield* inbox.answer(owner, { id: other.id, optionId: "pg", reason: "Chosen" });
      expect(
        (yield* Effect.flip(inbox.escalate(parent, { id: other.id, reason: "Too late" }))).code,
      ).toBe("invalid_request");
    }),
  ),
);

it.effect("a decision whose parent was never told is the person's", () =>
  withDispatches(() =>
    Effect.gen(function* () {
      yield* seedFamily;
      const inbox = yield* Inbox.DecisionInbox;
      const sql = yield* SqlClient.SqlClient;
      // Recorded before routing existed: no route row and no wake.
      yield* sql`INSERT INTO decision_items (id, from_thread_id, title, context, options_json, required_profile, status, created_at, updated_at)
        VALUES ('decision:old', 'child', 'Old', '', '[{"id":"a","label":"A","consequence":"a"}]', 'manager', 'open', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`;
      yield* projectWake("unrelated", "running");
      expect(yield* inbox.get(owner, "decision:old")).toMatchObject({
        routedTo: "person",
        from: { parentThreadId: "parent" },
      });
    }),
  ),
);
it.effect("a child's question waits for its parent only while the parent may still answer it", () =>
  withDispatches(() =>
    Effect.gen(function* () {
      yield* seedFamily;
      const inbox = yield* Inbox.DecisionInbox;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
        VALUES ('question', 'child', 'node', 'user_input', 'pending', '1970-01-01T00:00:00.000Z', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES ('item', 'child', 0, 'user_input_request', 'pending', '1970-01-01T00:00:00.000Z',
          '{"requestId":"question","questions":[{"id":"q","header":"Size","question":"Which size?","options":[{"label":"Small","description":"Small"}]}]}')`;
      yield* projectWake(questionEscalationMessageId("child", "question"), "queued");
      const id = pendingDecisionId("child", "question");
      expect(yield* inbox.get(owner, id)).toMatchObject({
        routedTo: "parent",
        from: { threadId: "child", parentThreadId: "parent" },
      });
      // The parent can no longer answer questions (no threads.launch): the person gets it.
      yield* (yield* Settings.ServerSettingsService).updateSettings({
        goatclaw: { defaultProfile: "observer" },
      });
      expect((yield* inbox.get(owner, id)).routedTo).toBe("person");
    }),
  ),
);
