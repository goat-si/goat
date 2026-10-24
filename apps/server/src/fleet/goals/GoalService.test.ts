import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../../serverSettings.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  type FleetGoalSpec,
  type GoatGoalApplyInput,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as McpClientAuthority from "../../auth/McpClientAuthority.ts";
import * as ServerConfig from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { layer as recoveryLayer } from "./GoalRecovery.ts";
import { GoalService, layer as goalServiceLayer } from "./GoalService.ts";
import { layer as goalStoreLayer } from "./GoalStore.ts";
import { testSpec } from "./goalTestkit.ts";

const modes = new Map<
  string,
  { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode }
>([
  ["thread:owner", { runtimeMode: "full-access", interactionMode: "default" }],
  ["thread:careful", { runtimeMode: "auto-accept-edits", interactionMode: "default" }],
  ["thread:planner", { runtimeMode: "full-access", interactionMode: "plan" }],
  ["thread:admin", { runtimeMode: "full-access", interactionMode: "default" }],
]);

/** Client sessions that are live and control threads; any other id reads as revoked. */
const liveClients = new Set(["client", "client:second"]);

const servicesFor = (profile?: string) =>
  goalServiceLayer.pipe(
    Layer.provide(
      Layer.succeed(McpClientAuthority.McpClientAuthority, {
        load: (sessionId) =>
          Effect.succeed(
            liveClients.has(sessionId)
              ? {
                  sessionId: AuthSessionId.make(sessionId),
                  grantedScopes: ["orchestration:operate" as const],
                  reauthorize: () => Effect.void,
                }
              : { unavailable: "The MCP client session was revoked or has expired." },
          ),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        goatclaw: { enabled: profile !== undefined, defaultProfile: profile ?? "worker" },
      }),
    ),
    Layer.provideMerge(
      recoveryLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectStoreV2)({}),
            ProcessRunner.layer,
            ServerConfig.layerTest(process.cwd(), { prefix: "goal-service-" }),
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(goalStoreLayer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(liveThreadShell(threadId, modes.get(threadId) ?? {})),
      }),
    ),
  );

const services = servicesFor();

const scopeOf = (threadId: string | null): McpInvocationScope => ({
  environmentId: EnvironmentId.make("env:test"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 0,
  requestNamespace: "test",
  thread:
    threadId === null
      ? undefined
      : {
          threadId: ThreadId.make(threadId),
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
  client:
    threadId === null ? { sessionId: "client", label: "bot", access: "full-access" } : undefined,
});

const clientScope = (
  sessionId: string,
  access: "read-only" | RuntimeMode = "full-access",
): McpInvocationScope => ({
  ...scopeOf(null),
  requestNamespace: "client:" + sessionId,
  client: { sessionId, label: "bot", access },
});

const input = (
  overrides: Partial<GoatGoalApplyInput> = {},
  spec: Partial<FleetGoalSpec> = {},
): GoatGoalApplyInput => ({
  title: "Ship",
  spec: testSpec({ workers: { ...testSpec().workers, runtimeMode: "auto-accept-edits" }, ...spec }),
  ...overrides,
});

const apply = (threadId: string | null, value: GoatGoalApplyInput) =>
  GoalService.pipe(Effect.flatMap((goals) => goals.apply(scopeOf(threadId), value)));
const applyAs = (scope: McpInvocationScope, value: GoatGoalApplyInput) =>
  GoalService.pipe(Effect.flatMap((goals) => goals.apply(scope, value)));
const codeOf = <A, R>(effect: Effect.Effect<A, { readonly code: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

describe("GoalService", () => {
  it.effect("creates once per clientRequestId and bumps generation only on a change", () =>
    Effect.gen(function* () {
      const first = yield* apply("thread:owner", input({ clientRequestId: "r1" }));
      expect(first.goal.id).toMatch(/^goal_[0-9a-z]{26}$/);
      expect(first.goal.owner).toEqual({
        kind: "thread",
        threadId: "thread:owner",
        mcpOwner: null,
        runtimeModeCeiling: "full-access",
      });
      expect(yield* apply("thread:owner", input({ clientRequestId: "r1" }))).toMatchObject({
        created: false,
        goal: { id: first.goal.id },
      });
      expect(yield* apply("thread:owner", input({ id: first.goal.id }))).toMatchObject({
        changed: false,
        goal: { generation: 1 },
      });
      expect(
        yield* apply("thread:owner", input({ id: first.goal.id, title: "Ship v2" })),
      ).toMatchObject({ changed: true, goal: { generation: 2 } });
      expect(
        yield* codeOf(
          apply("thread:owner", input({ id: first.goal.id, title: "v3", expectedGeneration: 1 })),
        ),
      ).toBe("conflict");
      const dry = yield* apply("thread:owner", input({ dryRun: true }));
      expect(dry.dryRun).toBe(true);
      expect(
        yield* codeOf(
          GoalService.pipe(
            Effect.flatMap((goals) => goals.get(scopeOf("thread:owner"), dry.goal.id)),
          ),
        ),
      ).toBe("not_found");
    }).pipe(Effect.provide(services)),
  );

  it.effect("never lets a goal act above the thread that declares it", () =>
    Effect.gen(function* () {
      // An in-process call with neither a thread nor a client has no one for the goal to act as.
      expect(yield* codeOf(applyAs({ ...scopeOf(null), client: undefined }, input()))).toBe(
        "thread_credential_required",
      );
      expect(yield* codeOf(apply("thread:planner", input()))).toBe(
        "interaction_mode_escalation_denied",
      );
      expect(
        yield* codeOf(
          apply(
            "thread:careful",
            input({}, { workers: { ...testSpec().workers, runtimeMode: "full-access" } }),
          ),
        ),
      ).toBe("runtime_mode_escalation_denied");
      expect(
        yield* codeOf(
          apply(
            "thread:careful",
            input(
              {},
              {
                workers: {
                  ...testSpec().workers,
                  runtimeMode: "auto-accept-edits",
                  hostSelector: { hosts: ["mac-studio"] },
                },
              },
            ),
          ),
        ),
      ).toBe("invalid_request");
      // Workers on other machines are refused for everyone until remote authority lands.
      expect(
        yield* codeOf(
          apply(
            "thread:owner",
            input(
              {},
              { workers: { ...testSpec().workers, hostSelector: { hosts: [null, "mac-studio"] } } },
            ),
          ),
        ),
      ).toBe("invalid_request");
      const careful = yield* apply("thread:careful", input());
      expect(careful.goal.owner.runtimeModeCeiling).toBe("auto-accept-edits");
      // Another thread may not rewrite the spec, even with full access.
      expect(
        yield* codeOf(apply("thread:admin", input({ id: careful.goal.id, title: "Mine now" }))),
      ).toBe("capability_denied");
    }).pipe(Effect.provide(services)),
  );

  it.effect("lowers the ceiling on update and never raises it", () =>
    Effect.gen(function* () {
      const created = yield* apply("thread:owner", input());
      modes.set("thread:owner", { runtimeMode: "auto-accept-edits", interactionMode: "default" });
      const lowered = yield* apply(
        "thread:owner",
        input({ id: created.goal.id, title: "Lowered" }),
      );
      expect(lowered.goal.owner.runtimeModeCeiling).toBe("auto-accept-edits");
      modes.set("thread:owner", { runtimeMode: "full-access", interactionMode: "default" });
      const again = yield* apply("thread:owner", input({ id: created.goal.id, title: "Raised?" }));
      expect(again.goal.owner.runtimeModeCeiling).toBe("auto-accept-edits");
    }).pipe(Effect.provide(services)),
  );

  it.effect(
    "lets the owner or a full-access thread pause and delete, and lists only your goals",
    () =>
      Effect.gen(function* () {
        const goals = yield* GoalService;
        const mine = yield* apply("thread:owner", input());
        expect(yield* codeOf(goals.setPaused(scopeOf("thread:careful"), mine.goal.id, true))).toBe(
          "capability_denied",
        );
        expect(yield* goals.setPaused(scopeOf("thread:admin"), mine.goal.id, true)).toMatchObject({
          generation: 2,
          spec: { paused: true },
        });
        expect(
          (yield* goals.list(scopeOf("thread:careful"), {})).goals.map((goal) => goal.id),
        ).not.toContain(mine.goal.id);
        const requested = yield* goals.remove(scopeOf("thread:owner"), { id: mine.goal.id });
        expect(requested).toMatchObject({
          deleted: false,
          goal: { deletionRequestedAt: expect.any(String) },
        });
        expect(
          yield* codeOf(apply("thread:owner", input({ id: mine.goal.id, title: "late" }))),
        ).toBe("conflict");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO fleet_replicas (owner_key, generation, ref, file, commit_oid, captured_at)
          VALUES (${"goal:" + mine.goal.id + ":s0"}, 1, 'refs/goat/replicas/x/1', '/nonexistent', 'a', '2026-10-21')`;
        expect(
          yield* goals.remove(scopeOf("thread:owner"), { id: mine.goal.id, force: true }),
        ).toMatchObject({ deleted: true });
        // A forced removal skips the controller, so it drops the goal's replicas itself.
        expect(yield* sql`SELECT owner_key FROM fleet_replicas`).toEqual([]);
        expect(yield* codeOf(goals.get(scopeOf("thread:owner"), mine.goal.id))).toBe("not_found");
      }).pipe(Effect.provide(services)),
  );
});

describe("GoalService with an outside client owner (#493)", () => {
  it.effect("records the client session as owner and keeps its goals to that client", () =>
    Effect.gen(function* () {
      const goals = yield* GoalService;
      const bot = clientScope("client");
      const created = yield* applyAs(bot, input({ clientRequestId: "r1" }));
      expect(created.goal.owner).toEqual({
        kind: "mcp_client",
        threadId: null,
        mcpOwner: "client:client",
        runtimeModeCeiling: "full-access",
      });
      const id = created.goal.id;
      // A retried create returns the same goal; a request key is the client's own.
      expect((yield* applyAs(bot, input({ clientRequestId: "r1" }))).goal.id).toBe(id);
      expect(
        (yield* applyAs(clientScope("client:second"), input({ clientRequestId: "r1" }))).goal.id,
      ).not.toBe(id);
      expect(yield* applyAs(bot, input({ id, title: "Ship v2" }))).toMatchObject({
        changed: true,
        goal: { generation: 2 },
      });
      expect((yield* goals.get(bot, id)).goal.title).toBe("Ship v2");
      expect((yield* goals.list(bot, {})).goals.map((goal) => goal.id)).toEqual([id]);
      expect(yield* goals.setPaused(bot, id, true)).toMatchObject({ spec: { paused: true } });
      expect(yield* goals.setPaused(bot, id, false)).toMatchObject({ spec: { paused: false } });

      // Another client, with full access too, reaches none of it; the goal reads as missing.
      const other = clientScope("client:second");
      expect(yield* codeOf(goals.get(other, id))).toBe("not_found");
      expect((yield* goals.list(other, {})).goals.map((goal) => goal.id)).not.toContain(id);
      expect(yield* codeOf(goals.setPaused(other, id, true))).toBe("not_found");
      expect(yield* codeOf(goals.remove(other, { id, force: true }))).toBe("not_found");
      expect(yield* codeOf(applyAs(other, input({ id, title: "Mine now" })))).toBe("not_found");
      // Nor does the client reach a thread's goal.
      const threads = yield* apply("thread:owner", input());
      expect(yield* codeOf(goals.get(bot, threads.goal.id))).toBe("not_found");
      expect(yield* codeOf(goals.setPaused(bot, threads.goal.id, true))).toBe("not_found");
      expect((yield* goals.list(bot, {})).goals.map((goal) => goal.id)).toEqual([id]);
      // A thread without full access may not manage the client's goal; a full-access one may.
      expect(yield* codeOf(goals.setPaused(scopeOf("thread:careful"), id, true))).toBe(
        "capability_denied",
      );
      expect(yield* goals.setPaused(scopeOf("thread:admin"), id, true)).toMatchObject({
        spec: { paused: true },
      });
      expect(yield* goals.remove(bot, { id })).toMatchObject({ deleted: false });
      expect(yield* goals.remove(bot, { id, force: true })).toMatchObject({ deleted: true });
      expect(yield* codeOf(goals.get(bot, id))).toBe("not_found");
    }).pipe(Effect.provide(services)),
  );

  it.effect("caps the goal at the client's approved access and refuses a lapsed session", () =>
    Effect.gen(function* () {
      const careful = clientScope("client", "auto-accept-edits");
      const created = yield* applyAs(careful, input());
      expect(created.goal.owner.runtimeModeCeiling).toBe("auto-accept-edits");
      expect(
        yield* codeOf(
          applyAs(careful, input({}, { workers: { ...testSpec().workers, runtimeMode: "auto" } })),
        ),
      ).toBe("runtime_mode_escalation_denied");
      // The goal is checked later by its session id alone, so that session must be live now.
      expect(yield* codeOf(applyAs(clientScope("client:revoked"), input()))).toBe(
        "capability_denied",
      );
    }).pipe(Effect.provide(services)),
  );
});

it.effect.each(["worker", "manager"])(
  "goal apply enforces profile %s at the service boundary",
  (profile) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES ('thread:owner', 'project:test', 'Caller', 'codex', 'full-access', 'default', '2026-10-21', '2026-10-21', '{}')`;
      const result = yield* apply("thread:owner", input()).pipe(Effect.result);
      if (profile === "worker") {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.message).toContain("goals.apply");
      } else expect(result._tag).toBe("Success");
    }).pipe(Effect.provide(servicesFor(profile))),
);
