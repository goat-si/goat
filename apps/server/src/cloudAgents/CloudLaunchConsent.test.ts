import { expect, it } from "@effect/vitest";
import { EnvironmentId, type HandoffSummary } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import type * as Handoffs from "../handoffs/Handoffs.ts";
import {
  instanceId,
  person,
  threadId,
  withApprovals,
} from "../handoffs/ApprovalHandoffs.testkit.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeCloudLaunchConsent, type CloudLaunchBinding } from "./CloudLaunchConsent.ts";

const fromThread: McpInvocationScope = {
  environmentId: EnvironmentId.make("origin"),
  requestNamespace: "test:thread",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: { threadId, providerSessionId: "session", providerInstanceId: instanceId },
  client: undefined,
};
const launch: CloudLaunchBinding = {
  provider: "cursorCloud",
  repo: "goat-si/goat",
  branch: null,
  prompt: "Inspect the flaky test",
  title: null,
  notifyWebhook: null,
  holder: { host: null, instanceId: "cursorCloud" },
  threadId,
};

/** Cloud consent with goatclaw on, an owner default profile, and the real handoff service. */
const withConsent = <A, E>(
  body: (input: {
    readonly admit: (
      binding: CloudLaunchBinding,
      ids?: { readonly handoffId?: string; readonly decisionId?: string },
      scope?: McpInvocationScope,
    ) => Effect.Effect<
      { readonly admitted: true } | { readonly admitted: false; readonly handoff: HandoffSummary },
      { readonly message: string }
    >;
    readonly respond: (
      handoffId: HandoffSummary["handoffId"],
      action: "completed" | "declined",
    ) => ReturnType<Handoffs.Handoffs["Service"]["respond"]>;
    readonly sql: SqlClient.SqlClient;
  }) => Effect.Effect<A, E>,
  startedBy: "person" | "agent" = "agent",
) =>
  withApprovals(
    ({ handoffs }) =>
      Effect.gen(function* () {
        const consent = yield* makeCloudLaunchConsent;
        const permissions = yield* Profiles.PermissionProfiles;
        return yield* body({
          sql: yield* SqlClient.SqlClient,
          respond: (handoffId, action) => handoffs.respond({ threadId, handoffId, action }, person),
          admit: (binding, ids = {}, scope = fromThread) =>
            Effect.gen(function* () {
              const effective = yield* permissions.require(scope, "cloud.launch");
              return yield* consent.admit(scope, effective, {
                decisionId: ids.decisionId,
                handoffId: ids.handoffId,
                target: "cursorCloud@local",
                binding,
                request: {
                  title: "Allow a Cursor Cloud run?",
                  reason: "Bills.",
                  location: "Prompt",
                },
              });
            }),
        });
      }).pipe(
        Effect.provide(
          DecisionInbox.layer.pipe(
            Layer.provide(Layer.mock(PendingQuestions.PendingQuestionsMcpService)({})),
            Layer.provideMerge(Profiles.layer),
            Layer.provide(
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(EnvironmentId.make("origin")),
              }),
            ),
            Layer.provide(
              ServerSettings.layerTest({ goatclaw: { enabled: true, defaultProfile: "owner" } }),
            ),
          ),
        ),
      ),
    { startedBy },
  );

const message = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "admitted" }));

it.effect("a person's approval admits exactly the launch it was asked for, once", () =>
  withConsent(({ admit, respond, sql }) =>
    Effect.gen(function* () {
      const asked = yield* admit(launch);
      if (asked.admitted) return expect.unreachable("an agent's launch needs a person");
      expect(asked.handoff).toMatchObject({ targetPath: "cloud_agent.launch", state: "pending" });
      expect(asked.handoff.expiresAt).not.toBeNull();
      const handoffId = asked.handoff.handoffId;
      expect(yield* message(admit(launch, { handoffId }))).toContain("still open");
      yield* respond(handoffId, "completed");
      expect(
        yield* message(admit({ ...launch, prompt: "Delete the repo" }, { handoffId })),
      ).toContain("does not cover");
      expect(
        yield* message(
          admit(
            { ...launch, holder: { host: "lidge-ts", instanceId: "cursorCloud" } },
            { handoffId },
          ),
        ),
      ).toContain("does not cover");
      expect(yield* message(admit(launch, { handoffId }))).toBe("admitted");
      expect(yield* message(admit(launch, { handoffId }))).toContain("already used");
      const audit = yield* sql<{ readonly outcome: string }>`SELECT outcome FROM audit_events
        WHERE action = 'cloud.launch' AND decision_id = ${handoffId}`;
      expect(audit.map((row) => row.outcome)).toEqual(["handoff"]);
    }),
  ),
);

it.effect("from a thread, a declined handoff or an inbox decision admits nothing", () =>
  withConsent(({ admit, respond }) =>
    Effect.gen(function* () {
      const asked = yield* admit(launch);
      if (asked.admitted) return expect.unreachable("an agent's launch needs a person");
      yield* respond(asked.handoff.handoffId, "declined");
      expect(yield* message(admit(launch, { handoffId: asked.handoff.handoffId }))).toContain(
        "was not given",
      );
      // A thread's decisionId binds no launch, so the thread is asked for a handoff instead.
      const again = yield* admit(launch, { decisionId: "decision:any" });
      expect(again.admitted).toBe(false);
    }),
  ),
);

it.effect("a launch in a turn a person started needs no further approval", () =>
  withConsent(
    ({ admit }) =>
      Effect.gen(function* () {
        expect(yield* admit(launch)).toEqual({ admitted: true });
      }),
    "person",
  ),
);

it.effect("handoffId only works from the thread that asked", () =>
  withConsent(({ admit }) =>
    Effect.gen(function* () {
      const outside: McpInvocationScope = {
        ...fromThread,
        thread: undefined,
        client: { sessionId: "outside", label: "Bot", access: "full-access" },
      };
      expect(yield* message(admit(launch, { handoffId: "handoff:any" }, outside))).toContain(
        "only from the thread that asked",
      );
    }),
  ),
);

it.effect("outside a thread, only the decision GOAT filed for this launch admits it, once", () =>
  withConsent(({ admit, sql }) =>
    Effect.gen(function* () {
      const outside: McpInvocationScope = {
        ...fromThread,
        thread: undefined,
        client: { sessionId: "outside", label: "Bot", access: "full-access" },
      };
      const unbound = { ...launch, threadId: null };
      const asked = yield* message(admit(unbound, {}, outside));
      expect(asked).toContain("bills a paid account");
      const decisionId = /decision (decision:\S+) for/.exec(asked)![1]!;
      // An agent's own decision, even once a person approves it, binds no launch.
      yield* sql`INSERT INTO decision_items (id, title, context, options_json, required_profile,
        status, answer, answered_by, created_at, updated_at) VALUES ('decision:own', 'Launch?', '',
        '[]', 'owner', 'answered', 'approve', 'client:phone', '2026-10-21', '2026-10-21')`;
      yield* sql`UPDATE decision_items SET status = 'answered', answer = 'approve',
        answered_by = 'client:phone' WHERE id = ${decisionId}`;
      for (const [binding, id] of [
        [unbound, "decision:own"],
        [{ ...unbound, prompt: "Delete the repo" }, decisionId],
      ] as const)
        expect(yield* message(admit(binding, { decisionId: id }, outside))).toContain(
          "was not filed by GOAT for this launch",
        );
      expect(yield* message(admit(unbound, { decisionId }, outside))).toBe("admitted");
      expect(yield* message(admit(unbound, { decisionId }, outside))).not.toBe("admitted");
    }),
  ),
);
