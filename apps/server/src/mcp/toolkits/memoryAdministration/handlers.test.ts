import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpServer } from "effect/ai";
import * as Fixture from "../memory/handlers.testkit.ts";
const decodeDisabled = Schema.decodeUnknownEffect(M.MemoryHubDisableResult);
const decodeSettings = Schema.decodeUnknownEffect(M.MemorySettingsView);
it.effect(
  "reads defaults and updates generation, model and hub sharing with settings authority",
  () =>
    Effect.gen(function* () {
      const initial = yield* Fixture.call("memory_settings_get", {});
      const defaults = yield* decodeSettings(initial.body);
      expect(defaults).toMatchObject({
        enabled: true,
        hub: { mode: "disabled" },
        model: { selection: { instanceId: "codex", model: "gpt-6-luna" }, automatic: true },
      });
      expect(
        (yield* Fixture.call("memory_settings_update", {
          requestId: Fixture.id(21),
          enabled: false,
        })).body,
      ).toMatchObject({ code: "unavailable" });
      const granted = Fixture.scope(["memory:read", "settings:write"]);
      const selection = { instanceId: "codex", model: "gpt-6-sol" };
      const updated = yield* Fixture.call(
        "memory_settings_update",
        {
          requestId: Fixture.id(22),
          enabled: false,
          modelSelection: selection,
        },
        granted,
      );
      expect(yield* decodeSettings(updated.body)).toMatchObject({
        enabled: false,
        model: { selection, automatic: false },
      });
      const enabled = yield* Fixture.call(
        "memory_settings_update",
        {
          requestId: Fixture.id(23),
          hubSync: { enabled: true, expectedVersion: defaults.hub.version },
        },
        granted,
      );
      const hub = yield* decodeSettings(enabled.body);
      expect(hub.hub.mode).toBe("hub");
      const disabled = yield* Fixture.call(
        "memory_settings_update",
        {
          requestId: Fixture.id(24),
          hubSync: { enabled: false, expectedVersion: hub.hub.version },
          enabled: true,
          modelSelection: null,
        },
        granted,
      );
      expect(yield* decodeSettings(disabled.body)).toMatchObject({
        enabled: true,
        hub: { mode: "disabled" },
        model: { selection: { instanceId: "codex", model: "gpt-6-luna" }, automatic: true },
      });
    }).pipe(Effect.provide(Fixture.layer)),
);
it.effect("disable uses explicit settings grant and CAS, returns only the disabled view", () =>
  Effect.gen(function* () {
    const input = { requestId: M.MemoryOperationId.make(Fixture.id(10)), expectedVersion: 0 };
    expect((yield* Fixture.call("memory_hub_disable", input)).body).toMatchObject({
      code: "unavailable",
    });
    const granted = Fixture.scope(["settings:write"]);
    const result = yield* Fixture.call("memory_hub_disable", input, granted);
    expect(result.result.isError).not.toBe(true);
    const view = yield* decodeDisabled(result.body);
    expect(view.settings.mode).toBe("disabled");
    expect(result.body).not.toHaveProperty("credential");
    expect(result.body).not.toHaveProperty("members");
    expect(Object.keys(result.body as object).sort()).toEqual(["settings", "version"]);
    expect(
      (yield* Fixture.call(
        "memory_hub_disable",
        { requestId: M.MemoryOperationId.make(Fixture.id(11)), expectedVersion: 0 },
        granted,
      )).result.isError,
    ).toBe(true);
    expect(
      (yield* Fixture.call(
        "memory_hub_disable",
        { requestId: M.MemoryOperationId.make(Fixture.id(12)), expectedVersion: view.version },
        { ...granted, readOnly: true },
      )).result.isError,
    ).toBe(true);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("binding reads require memory write authority and never create a binding", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name)).not.toContain("goat_memory_binding_update");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT)`;
    yield* sql`INSERT INTO projection_projects VALUES ('project', '/synthetic', NULL)`;
    const input = {
      memorySpaceId: Fixture.space,
      project: { environmentId: "fixture-memory-mcp", projectId: "project" },
    };
    expect(
      (yield* Fixture.call("goat_memory_binding_read", input, Fixture.scope(["memory:read"])))
        .result.isError,
    ).toBe(true);
    expect((yield* Fixture.call("goat_memory_binding_read", input)).body).toEqual({
      binding: null,
    });
    const rows = yield* sql`SELECT * FROM memory_project_bindings`;
    expect(rows).toHaveLength(0);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect(
  "report reset requires both scopes and repeating it leaves a reset report unchanged",
  () =>
    Effect.gen(function* () {
      const input = {
        memorySpaceId: Fixture.space,
        environmentId: "fixture-memory-mcp",
        reportIds: ["a".repeat(64)],
      };
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,resolving_environment_id,outcome,state,created_at,report_kind,report_approved,automatic_attempts,failure_code) VALUES (${input.reportIds[0]},${Fixture.space},${Fixture.memoryId},${Fixture.id(10)},${Fixture.id(11)},${input.environmentId},'resolved','failed',0,'resolve',1,10,'unavailable')`;
      expect((yield* Fixture.call("goat_memory_report_attempts_reset", input)).result.isError).toBe(
        true,
      );
      const granted = Fixture.scope(["settings:write", "memory:read"]);
      expect(
        (yield* Fixture.call("goat_memory_report_attempts_reset", input, {
          ...granted,
          readOnly: true,
        })).result.isError,
      ).toBe(true);
      const first = yield* Fixture.call("goat_memory_report_attempts_reset", input, granted);
      expect(first.result.isError).not.toBe(true);
      expect(first.body).toEqual({ resetCount: 1, unchangedCount: 0 });
      expect(
        (yield* Fixture.call("goat_memory_report_attempts_reset", input, granted)).body,
      ).toEqual({ resetCount: 0, unchangedCount: 1 });
      const rows = yield* sql<{
        automatic_attempts: number;
      }>`SELECT automatic_attempts FROM memory_report_outbox WHERE report_id=${input.reportIds[0]}`;
      expect(rows[0]?.automatic_attempts).toBe(0);
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("hub diagnostics and reconciliation enforce their respective scopes", () =>
  Effect.gen(function* () {
    expect(
      (yield* Fixture.call("goat_memory_hub_diagnostics", {}, Fixture.scope([]))).result.isError,
    ).toBe(true);
    expect(
      (yield* Fixture.call("goat_memory_hub_diagnostics", {}, Fixture.scope(["memory:read"]))).body,
    ).toMatchObject({ reconcile: "available", recoverableHolds: ["availability"] });
    const input = {
      memorySpaceId: Fixture.space,
      environmentId: "fixture-memory-mcp",
      expectedVersion: 1,
    };
    expect((yield* Fixture.call("goat_memory_hub_reconcile", input)).result.isError).toBe(true);
    const granted = Fixture.scope(["settings:write", "memory:read"]);
    const first = yield* Fixture.call("goat_memory_hub_reconcile", input, granted);
    expect(first.body).toEqual({ version: 1, rearmedClasses: ["availability"] });
    expect((yield* Fixture.call("goat_memory_hub_reconcile", input, granted)).body).toEqual(
      first.body,
    );
    const revoked = {
      ...granted,
      reauthorize: () =>
        Effect.fail(
          new M.EnvironmentAuthorizationError({
            message: "revoked",
            requiredScope: "settings:write",
          }),
        ),
    };
    expect((yield* Fixture.call("goat_memory_hub_reconcile", input, revoked)).result.isError).toBe(
      true,
    );
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("plan-mode threads cannot run memory administration writes", () =>
  Effect.gen(function* () {
    const scope = {
      ...Fixture.scope(["memory:read", "settings:write"]),
      client: undefined,
      thread: {
        threadId: M.ThreadId.make("plan-thread"),
        providerSessionId: "fixture",
        providerInstanceId: M.ProviderInstanceId.make("codex"),
      },
    };
    const hub = {
      memorySpaceId: Fixture.space,
      environmentId: "fixture-memory-mcp",
      expectedVersion: 1,
    };
    const reports = {
      memorySpaceId: Fixture.space,
      environmentId: "fixture-memory-mcp",
      reportIds: ["a".repeat(64)],
    };
    for (const [name, input] of [
      ["goat_memory_hub_reconcile", hub],
      ["goat_memory_report_attempts_reset", reports],
    ] as const) {
      const result = yield* Fixture.call(name, input, scope);
      expect(result.result.isError).toBe(true);
      expect(result.body).toMatchObject({ code: "capability_denied" });
    }
  }).pipe(Effect.provide(Fixture.planLayer)),
);

it.effect("memory recovery writes refuse a settings-only caller before changing anything", () =>
  Effect.gen(function* () {
    const settingsOnly = Fixture.scope(["settings:write"]);
    const hub = {
      memorySpaceId: Fixture.space,
      environmentId: "fixture-memory-mcp",
      expectedVersion: 1,
    };
    const report = {
      memorySpaceId: Fixture.space,
      environmentId: "fixture-memory-mcp",
      reportIds: ["a".repeat(64)],
    };
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,resolving_environment_id,outcome,state,created_at,report_kind,report_approved,automatic_attempts,failure_code) VALUES (${report.reportIds[0]},${Fixture.space},${Fixture.memoryId},${Fixture.id(10)},${Fixture.id(11)},${report.environmentId},'resolved','failed',0,'resolve',1,10,'unavailable')`;
    expect(
      (yield* Fixture.call("goat_memory_hub_reconcile", hub, settingsOnly)).result.isError,
    ).toBe(true);
    expect(
      (yield* Fixture.call("goat_memory_report_attempts_reset", report, settingsOnly)).result
        .isError,
    ).toBe(true);
    const granted = Fixture.scope(["settings:write", "memory:read"]);
    const revokedRead = {
      ...granted,
      reauthorize: (required: ReadonlyArray<M.AuthEnvironmentScope>) =>
        required.includes("memory:read")
          ? Effect.fail(
              new M.EnvironmentAuthorizationError({
                message: "revoked",
                requiredScope: "memory:read",
              }),
            )
          : Effect.void,
    };
    expect(
      (yield* Fixture.call("goat_memory_hub_reconcile", hub, revokedRead)).result.isError,
    ).toBe(true);
    expect(
      (yield* Fixture.call("goat_memory_report_attempts_reset", report, revokedRead)).result
        .isError,
    ).toBe(true);
    const rows = yield* sql<{
      automatic_attempts: number;
    }>`SELECT automatic_attempts FROM memory_report_outbox WHERE report_id=${report.reportIds[0]}`;
    expect(rows[0]?.automatic_attempts).toBe(10);
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("a GOAT thread's own credential cannot run the memory recovery writes", () =>
  Effect.gen(function* () {
    // A thread is issued memory and orchestration scopes, never settings:write, so these writes
    // belong to outside MCP clients a person granted settings:write.
    const thread = {
      ...Fixture.scope(["memory:read", "memory:write", "orchestration:read"]),
      client: undefined,
      thread: {
        threadId: M.ThreadId.make("default-thread"),
        providerSessionId: "fixture",
        providerInstanceId: M.ProviderInstanceId.make("codex"),
      },
    };
    const report = {
      memorySpaceId: Fixture.space,
      environmentId: "fixture-memory-mcp",
      reportIds: ["b".repeat(64)],
    };
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,resolving_environment_id,outcome,state,created_at,report_kind,report_approved,automatic_attempts,failure_code) VALUES (${report.reportIds[0]},${Fixture.space},${Fixture.memoryId},${Fixture.id(12)},${Fixture.id(13)},${report.environmentId},'resolved','failed',0,'resolve',1,10,'unavailable')`;
    const hub = {
      memorySpaceId: Fixture.space,
      environmentId: "fixture-memory-mcp",
      expectedVersion: 1,
    };
    expect((yield* Fixture.call("goat_memory_hub_reconcile", hub, thread)).result.isError).toBe(
      true,
    );
    expect(
      (yield* Fixture.call("goat_memory_report_attempts_reset", report, thread)).result.isError,
    ).toBe(true);
    const rows = yield* sql<{
      automatic_attempts: number;
    }>`SELECT automatic_attempts FROM memory_report_outbox WHERE report_id=${report.reportIds[0]}`;
    expect(rows[0]?.automatic_attempts).toBe(10);
  }).pipe(Effect.provide(Fixture.layer)),
);
