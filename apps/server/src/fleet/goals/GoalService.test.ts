import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../../serverSettings.ts";
import { describe, expect, it } from "@effect/vitest";
import {
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

const servicesFor = (profile?: string) =>
  goalServiceLayer.pipe(
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
      expect(yield* codeOf(apply(null, input()))).toBe("thread_credential_required");
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
