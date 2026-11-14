import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PermissionProfiles, layer } from "./PermissionProfiles.ts";

const outside: McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "profiles",
  thread: undefined,
  client: { sessionId: "profiles", label: "test", access: "full-access" },
};

const fixture = layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(
    ServerSettings.layerTest({ goatclaw: { enabled: true, defaultProfile: "manager" } }),
  ),
);

it.effect.each(["host_unreachable", "cancelled"] as const)(
  "regression #3092: a pending lane is released when its launch ended or was fenced without a remote thread (%s)",
  (outcome) =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* ServerSettings.ServerSettingsService;
      const policy = (yield* settings.getSettings).goatclaw;
      yield* settings.updateSettings({
        goatclaw: {
          ...policy,
          profiles: { ...policy.profiles, manager: { ...policy.profiles.manager!, maxLanes: 1 } },
        },
      });
      yield* profiles.claim(outside, { id: "remote", host: "box", runtimeMode: "full-access" });
      yield* profiles.correlate("remote", "rr-unknown");
      yield* sql`INSERT INTO remote_dispatches (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, end_reason, ended_at, created_at, updated_at)
      VALUES ('rr-unknown', 'thread', 'caller', 'box', 'test', 'wake', ${outcome === "cancelled" ? "cancelled" : "lost"}, ${outcome === "cancelled" ? null : "host_unreachable"}, ${outcome === "cancelled" ? null : "2026-10-22"}, '2026-10-21', '2026-10-21')`;
      expect(
        (yield* profiles.claim(outside, { id: "another", host: "box", runtimeMode: "full-access" }))
          .enabled,
      ).toBe(true);
    }).pipe(Effect.provide(fixture)),
);
