import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import { decodeRemoteDispatchRows } from "../remoteReports/remoteDispatchRow.ts";
import { publicRow } from "../remoteReports/remoteDispatchModel.ts";
import { recordLostLaunchUnreachable } from "../remoteReports/remoteDispatchOutage.ts";
import { resolveLostThreadLaunches } from "../remoteReports/remoteDispatchRecovery.ts";
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

it.effect(
  "a late rebound counts above the lane limit and blocks admissions until both launches end",
  () =>
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
      const claim = (id: string) =>
        profiles.claim(outside, { id, host: "box", runtimeMode: "full-access" });
      yield* claim("old");
      yield* profiles.correlate("old", "rr-old");
      yield* sql`INSERT INTO remote_dispatches (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, host_unavailable_since, host_last_failed_at, created_at, updated_at)
      VALUES ('rr-old', 'thread', 'caller', 'box', 'test', 'wake', 'lost', '1969-12-30T23:50:00.000Z', '1969-12-31T23:50:00.000Z', '1969-12-30T23:00:00.000Z', '1969-12-30T23:00:00.000Z')`;
      expect((yield* claim("too-early").pipe(Effect.flip)).code).toBe("capability_denied");
      const [row] =
        yield* sql`SELECT * FROM remote_dispatches WHERE correlation_id = 'rr-old'`.pipe(
          Effect.flatMap(decodeRemoteDispatchRows),
        );
      if (row === undefined) return yield* Effect.die("missing dispatch");
      yield* recordLostLaunchUnreachable(publicRow(row)).pipe(
        Effect.provide(
          Layer.mock(Threads.ThreadManagementService)({
            dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
          }),
        ),
      );
      expect(
        (yield* sql<{
          end_reason: string;
        }>`SELECT end_reason FROM remote_dispatches WHERE correlation_id = 'rr-old'`)[0]
          ?.end_reason,
      ).toBe("host_unreachable");
      yield* claim("new");
      yield* profiles.correlate("new", "rr-new");
      yield* sql`INSERT INTO remote_dispatches (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, created_at, updated_at) VALUES ('rr-new', 'thread', 'caller', 'box', 'test', 'wake', 'running', '1969-12-30T23:00:00.000Z', '1969-12-30T23:00:00.000Z')`;
      yield* TestClock.adjust("11 minutes");
      yield* resolveLostThreadLaunches({ retryAt: new Map(), start: () => Effect.void }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(ThreadId.make("caller"))),
            }),
            Layer.mock(Ssh.SshRemoteDispatch)({
              callHostTool: () =>
                Effect.succeed({
                  _tag: "bound",
                  threadId: "old-thread",
                  originThreadId: "caller",
                  threadExists: true,
                  threadDeleted: false,
                  activeRunId: null,
                }),
            }),
          ),
        ),
      );
      expect(
        (yield* sql<{
          state: string;
        }>`SELECT state FROM remote_dispatches WHERE correlation_id = 'rr-old'`)[0]?.state,
      ).toBe("running");
      yield* settings.updateSettings({
        goatclaw: {
          ...policy,
          profiles: { ...policy.profiles, manager: { ...policy.profiles.manager!, maxLanes: 2 } },
        },
      });
      expect((yield* claim("third").pipe(Effect.flip)).code).toBe("capability_denied");
      yield* sql`UPDATE remote_dispatches SET state = 'settled' WHERE correlation_id = 'rr-new'`;
      yield* profiles.release("new", true);
      yield* settings.updateSettings({
        goatclaw: {
          ...policy,
          profiles: { ...policy.profiles, manager: { ...policy.profiles.manager!, maxLanes: 1 } },
        },
      });
      expect((yield* claim("third").pipe(Effect.flip)).code).toBe("capability_denied");
      yield* sql`UPDATE remote_dispatches SET state = 'settled' WHERE correlation_id = 'rr-old'`;
      yield* profiles.release("old", true);
      expect((yield* claim("third")).enabled).toBe(true);
    }).pipe(Effect.provide(fixture)),
);
