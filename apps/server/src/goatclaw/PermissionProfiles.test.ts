import { expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentId,
  PermissionCapability,
  ProviderInstanceId,
  ThreadId,
  type RuntimeMode,
  type PermissionProfile,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { PermissionProfiles, layer, intersectProfiles } from "./PermissionProfiles.ts";

const outside: McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "profiles",
  thread: undefined,
  client: { sessionId: "profiles", label: "test", access: "full-access" },
};
const threadScope = (id: string): McpInvocationScope => ({
  ...outside,
  client: undefined,
  thread: {
    threadId: ThreadId.make(id),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
});
const fixture = (profile = "worker", enabled = true) =>
  layer.pipe(
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(
      ServerSettings.layerTest({ goatclaw: { enabled, defaultProfile: profile } }),
    ),
  );
const seed = (id: string, mode: RuntimeMode = "full-access") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${id}, 'project', 'Test', 'codex', ${mode}, 'default', '2026-10-21', '2026-10-21', '{}')`;
  });

it.effect(
  "resolves outside clients from the default and narrows a thread's live runtime ceiling",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      expect(yield* profiles.resolve(outside)).toMatchObject({
        enabled: true,
        profile: { id: "worker" },
        runtimeMode: "auto",
      });
      yield* seed("caller", "auto-accept-edits");
      expect((yield* profiles.resolve(threadScope("caller"))).runtimeMode).toBe(
        "auto-accept-edits",
      );
      expect(
        (yield* profiles.resolve(threadScope("caller"), "approval-required")).runtimeMode,
      ).toBe("approval-required");
    }).pipe(Effect.provide(fixture())),
);

it.effect.each(Object.keys(BUILTIN_PERMISSION_PROFILES))(
  "checks every capability for builtin %s",
  (id) =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      for (const capability of PermissionCapability.literals) {
        const result = yield* profiles.check(outside, capability);
        expect(result.ok).toBe(BUILTIN_PERMISSION_PROFILES[id]!.capabilities.includes(capability));
        if (!result.ok) expect(result.reason).toContain(capability);
      }
    }).pipe(Effect.provide(fixture(id))),
);

it.effect("checks host allowlists and exact lane boundary", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    const settings = yield* ServerSettings.ServerSettingsService;
    const policy = (yield* settings.getSettings).goatclaw;
    yield* settings.updateSettings({
      goatclaw: {
        ...policy,
        profiles: { ...policy.profiles, manager: { ...policy.profiles.manager!, hosts: ["box"] } },
      },
    });
    expect(
      (yield* profiles.check(outside, "threads.remote", { host: "box", lanesRunning: 5 })).ok,
    ).toBe(true);
    expect((yield* profiles.check(outside, "threads.remote", { host: "other" })).ok).toBe(false);
    expect((yield* profiles.check(outside, "threads.launch", { lanesRunning: 6 })).ok).toBe(false);
  }).pipe(Effect.provide(fixture("manager"))),
);

it("intersects all optional ceilings without broadening an empty allowlist", () => {
  const original: PermissionProfile = {
    ...BUILTIN_PERMISSION_PROFILES.worker!,
    hosts: [],
    maxTurns: 5,
    maxWallClockMs: 100,
  };
  expect(
    intersectProfiles({ ...BUILTIN_PERMISSION_PROFILES.owner!, maxTurns: 10 }, original),
  ).toMatchObject({
    capabilities: original.capabilities,
    hosts: [],
    maxTurns: 5,
    maxWallClockMs: 100,
    maxLanes: 3,
    runtimeModeCeiling: "auto",
  });
});

it.effect(
  "binds before dispatch, keeps the inherited snapshot after profile broadening and refuses a deleted profile",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* profiles.claim(outside, {
        id: "child",
        childThreadId: ThreadId.make("child"),
        runtimeMode: "full-access",
      });
      yield* seed("child");
      yield* profiles.complete("child");
      const policy = (yield* settings.getSettings).goatclaw;
      yield* settings.updateSettings({
        goatclaw: {
          ...policy,
          profiles: { ...policy.profiles, worker: { ...policy.profiles.owner!, id: "worker" } },
        },
      });
      expect(yield* profiles.resolve(threadScope("child"))).toMatchObject({
        profile: {
          id: "worker",
          maxLanes: 3,
          capabilities: BUILTIN_PERMISSION_PROFILES.worker!.capabilities,
        },
        runtimeMode: "auto",
      });
      yield* settings.updateSettings({
        goatclaw: {
          ...policy,
          defaultProfile: "owner",
          profiles: { owner: policy.profiles.owner! },
        },
      });
      expect((yield* profiles.resolve(threadScope("child")).pipe(Effect.flip)).message).toContain(
        "no longer exists",
      );
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "admits concurrent claims atomically, keeps pending reservations across service reconstruction, and dedupes retries",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const claims = yield* Effect.forEach(
        ["a", "b", "c", "d"],
        (id) =>
          profiles
            .claim(outside, { id, childThreadId: ThreadId.make(id), runtimeMode: "full-access" })
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(claims.filter((result) => result._tag === "Success")).toHaveLength(3);
      const sql = yield* SqlClient.SqlClient;
      const first = (yield* sql<{
        id: string;
      }>`SELECT id FROM goatclaw_lane_reservations ORDER BY id`)[0]!.id;
      expect(
        (yield* profiles.claim(outside, {
          id: first,
          childThreadId: ThreadId.make(first),
          runtimeMode: "full-access",
        })).enabled,
      ).toBe(true);
      const rebuilt = yield* PermissionProfiles.pipe(Effect.provide(layer));
      expect(
        (yield* rebuilt
          .claim(outside, { id: "extra", runtimeMode: "full-access" })
          .pipe(Effect.flip)).message,
      ).toContain("at most 3");
      yield* profiles.release(first, true);
      expect(
        (yield* rebuilt.claim(outside, { id: "replacement", runtimeMode: "full-access" })).enabled,
      ).toBe(true);
    }).pipe(Effect.provide(fixture())),
);

it.effect("counts running children and releases capacity only once their run is terminal", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    const sql = yield* SqlClient.SqlClient;
    for (const id of ["a", "b", "c"]) {
      yield* profiles.claim(outside, {
        id,
        childThreadId: ThreadId.make(id),
        runtimeMode: "full-access",
      });
      yield* seed(id);
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${`run:${id}`}, ${id}, 1, 'codex', 'running', '2026-10-21', '{}')`;
      yield* profiles.complete(id);
    }
    expect(
      (yield* profiles.claim(outside, { id: "d", runtimeMode: "full-access" }).pipe(Effect.flip))
        .code,
    ).toBe("capability_denied");
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE thread_id = 'a'`;
    expect((yield* profiles.claim(outside, { id: "d", runtimeMode: "full-access" })).enabled).toBe(
      true,
    );
  }).pipe(Effect.provide(fixture())),
);

it.effect("refuses disallowed remote and worktree launches before recording any reservation", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    expect(
      (yield* profiles
        .claim(outside, { id: "remote", host: "box", runtimeMode: "full-access" })
        .pipe(Effect.flip)).message,
    ).toContain("threads.remote");
    const settings = yield* ServerSettings.ServerSettingsService;
    const policy = (yield* settings.getSettings).goatclaw;
    yield* settings.updateSettings({
      goatclaw: {
        profiles: {
          ...policy.profiles,
          worker: { ...policy.profiles.worker!, capabilities: ["threads.launch"] },
        },
      },
    });
    expect(
      (yield* profiles
        .claim(outside, { id: "worktree", worktree: true, runtimeMode: "full-access" })
        .pipe(Effect.flip)).message,
    ).toContain("worktree.create");
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT * FROM goatclaw_lane_reservations`).toHaveLength(0);
  }).pipe(Effect.provide(fixture())),
);

it.effect("rejects forged forwarded ceilings and disabled destinations", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    expect(
      (yield* profiles
        .resolve(threadScope("caller"), "full-access", BUILTIN_PERMISSION_PROFILES.owner)
        .pipe(Effect.flip)).message,
    ).toContain("outside dispatch");
    expect(
      (yield* profiles
        .resolve(outside, "full-access", BUILTIN_PERMISSION_PROFILES.worker)
        .pipe(Effect.flip)).message,
    ).toContain("disabled");
  }).pipe(Effect.provide(fixture("worker", false))),
);

it.effect(
  "disabled policy is a no-op for every capability, hosts, lane limits, modes and storage",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      for (const capability of PermissionCapability.literals)
        expect(
          (yield* profiles.check(outside, capability, { host: "any", lanesRunning: 999 })).ok,
        ).toBe(true);
      expect(
        yield* profiles.claim(outside, { id: "disabled", host: "any", runtimeMode: "full-access" }),
      ).toMatchObject({ enabled: false, runtimeMode: "full-access" });
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM goatclaw_lane_reservations`).toHaveLength(0);
    }).pipe(Effect.provide(fixture("observer", false))),
);

it.effect(
  "a pending launch remains counted after its thread exists but before its initial run commits",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      for (const id of ["a", "b", "c"]) {
        yield* profiles.claim(outside, {
          id,
          childThreadId: ThreadId.make(id),
          runtimeMode: "full-access",
        });
        yield* seed(id);
      }
      expect(
        (yield* profiles
          .claim(outside, { id: "too-many", runtimeMode: "full-access" })
          .pipe(Effect.flip)).message,
      ).toContain("at most 3");
    }).pipe(Effect.provide(fixture())),
);

it.effect("freezes the caller's runtime ceiling even when the named profile permits more", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    yield* profiles.claim(outside, {
      id: "careful",
      childThreadId: ThreadId.make("careful"),
      runtimeMode: "auto-accept-edits",
    });
    yield* seed("careful");
    expect((yield* profiles.resolve(threadScope("careful"))).runtimeMode).toBe("auto-accept-edits");
  }).pipe(Effect.provide(fixture("owner"))),
);

it.effect("rechecks profile tightening before a remote side effect", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    const initial = yield* profiles.claim(outside, {
      id: "remote",
      host: "box",
      runtimeMode: "full-access",
    });
    const settings = yield* ServerSettings.ServerSettingsService;
    const policy = (yield* settings.getSettings).goatclaw;
    yield* settings.updateSettings({
      goatclaw: {
        ...policy,
        profiles: { ...policy.profiles, manager: { ...policy.profiles.manager!, maxLanes: 1 } },
      },
    });
    expect(
      (yield* profiles.recheck(outside, initial, { host: "box" }).pipe(Effect.flip)).message,
    ).toContain("narrowed");
  }).pipe(Effect.provide(fixture("manager"))),
);

it.effect("retains lost remote lanes until durable terminal evidence", () =>
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
    yield* sql`INSERT INTO remote_dispatches (correlation_id, kind, origin_thread_id, host, remote_thread_id, read_key, delivery, state, created_at, updated_at)
    VALUES ('rr-test', 'thread', 'caller', 'box', 'child', 'test', 'wake', 'lost', '2026-10-21', '2026-10-21')`;
    yield* profiles.complete("remote", "child", "rr-test");
    expect(
      (yield* profiles
        .claim(outside, { id: "another", host: "box", runtimeMode: "full-access" })
        .pipe(Effect.flip)).code,
    ).toBe("capability_denied");
    yield* sql`UPDATE remote_dispatches SET state = 'settled' WHERE correlation_id = 'rr-test'`;
    expect(
      (yield* profiles.claim(outside, { id: "another", host: "box", runtimeMode: "full-access" }))
        .enabled,
    ).toBe(true);
  }).pipe(Effect.provide(fixture("manager"))),
);

it.effect(
  "toggling goatclaw preserves named profiles and profiles patches replace removed entries",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const policy = (yield* settings.getSettings).goatclaw;
      const manager = { ...policy.profiles.manager!, hosts: ["box"] };
      yield* settings.updateSettings({
        goatclaw: { profiles: { manager }, defaultProfile: "manager" },
      });
      yield* settings.updateSettings({ goatclaw: { enabled: false } });
      const updated = (yield* settings.getSettings).goatclaw;
      expect(updated).toEqual({ enabled: false, defaultProfile: "manager", profiles: { manager } });
    }).pipe(Effect.provide(fixture("manager"))),
);

it.effect(
  "a target with the same runtime but broader capabilities cannot receive delegated instructions",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* profiles.claim(outside, {
        id: "owner-child",
        childThreadId: ThreadId.make("owner-child"),
        runtimeMode: "auto",
      });
      yield* seed("owner-child", "auto");
      yield* profiles.complete("owner-child");
      yield* settings.updateSettings({ goatclaw: { defaultProfile: "worker" } });
      const error = yield* profiles
        .assertTarget(outside, ThreadId.make("owner-child"), "full-access", "auto")
        .pipe(Effect.flip);
      expect(error.message).toContain("exceeds the caller");
    }).pipe(Effect.provide(fixture("owner"))),
);
