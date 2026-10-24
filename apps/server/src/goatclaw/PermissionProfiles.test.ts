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
    ).toContain("goatclaw is off on this destination");
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

it.effect("a follow-up send rides the remote lane it targets and frees an untracked one", () =>
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
    yield* profiles.claim(outside, { id: "launch", host: "box", runtimeMode: "full-access" });
    yield* sql`INSERT INTO remote_dispatches (correlation_id, kind, origin_thread_id, host, remote_thread_id, read_key, delivery, state, created_at, updated_at)
    VALUES ('rr-send', 'thread', 'caller', 'box', 'child', 'test', 'wake', 'running', '2026-10-21', '2026-10-21')`;
    yield* profiles.complete("launch", "child", "rr-send");
    const send = (id: string, remoteThreadId: string) =>
      profiles.claim(outside, { id, host: "box", runtimeMode: "full-access", remoteThreadId });

    // The only lane is that thread, so steering it takes no second slot.
    yield* send("send-1", "child");
    yield* profiles.completeRemote("send-1", "box", "child");
    expect((yield* send("send-2", "other").pipe(Effect.flip)).code).toBe("capability_denied");

    yield* sql`UPDATE remote_dispatches SET state = 'settled' WHERE correlation_id = 'rr-send'`;
    yield* send("send-3", "other");
    // No dispatch here follows that thread, so nothing would ever end this reservation.
    yield* profiles.completeRemote("send-3", "box", "other");
    const left = yield* sql<{ id: string; correlation_id: string | null }>`
      SELECT id, correlation_id FROM goatclaw_lane_reservations WHERE id LIKE 'send-%' ORDER BY id`;
    expect(left).toEqual([{ id: "send-1", correlation_id: "rr-send" }]);
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
      // A person's change carries its time; fleet sync spreads the newest one.
      expect(updated).toEqual({
        enabled: false,
        defaultProfile: "manager",
        profiles: { manager },
        updatedAt: expect.any(String),
      });
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

const personRun = (threadId: string, createdBy: string, source: string, status = "running") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runId = `${threadId}:run`;
    const messageId = `${threadId}:message`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${runId}, ${threadId}, 1, 'codex', ${status}, '2026-10-21', ${JSON.stringify({ userMessageId: messageId })})`;
    yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${messageId}, ${threadId}, ${runId}, 'user', 0, '2026-10-21', '2026-10-21', ${JSON.stringify({ createdBy, creationSource: source })})`;
  });
const decision = (
  id: string,
  fromThread: string | null,
  answer: string | null,
  answeredBy: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO decision_items (id, from_thread_id, title, context, options_json, required_profile, status, answer, answered_by, created_at, updated_at)
      VALUES (${id}, ${fromThread}, 'Launch?', '', '[]', 'owner', ${answer === null ? "open" : "answered"}, ${answer}, ${answer === null ? null : answeredBy}, '2026-10-21', '2026-10-21')`;
  });

it.effect(
  "lets a cloud launch through only for a person's turn or one person-approved decision",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const sql = yield* SqlClient.SqlClient;
      const approve = (scope: McpInvocationScope, decisionId?: string) =>
        profiles.resolve(scope).pipe(
          Effect.flatMap((effective) =>
            profiles.requireCloudApproval(scope, effective, {
              decisionId,
              target: "cursorCloud@local",
            }),
          ),
          Effect.flip,
          Effect.map((error) => error.message),
          Effect.orElseSucceed(() => "admitted"),
        );
      for (const id of ["person", "agent", "relayed", "idle"]) yield* seed(id);
      yield* personRun("person", "user", "web");
      yield* personRun("agent", "agent", "mcp");
      yield* personRun("relayed", "user", "server");
      yield* personRun("idle", "user", "mobile", "completed");
      expect(yield* approve(threadScope("person"))).toBe("admitted");
      for (const id of ["agent", "relayed", "idle"])
        expect(yield* approve(threadScope(id))).toContain("bills a paid account");
      expect(yield* approve(outside)).toContain("bills a paid account");

      yield* decision("approved", "agent", "approve", "client:phone");
      yield* decision("declined", "agent", "decline", "client:phone");
      yield* decision("open", "agent", null, "");
      yield* decision("self", "agent", "approve", "thread:agent");
      yield* decision("elsewhere", "person", "approve", "client:phone");
      expect(yield* approve(threadScope("agent"), "declined")).toContain("not been approved");
      expect(yield* approve(threadScope("agent"), "open")).toContain("not been approved");
      expect(yield* approve(threadScope("agent"), "self")).toContain("a person approves");
      expect(yield* approve(threadScope("agent"), "elsewhere")).toContain(
        "not asked by this caller",
      );
      expect(yield* approve(threadScope("agent"), "missing")).toContain("not asked by this caller");
      expect(yield* approve(threadScope("agent"), "approved")).toBe("admitted");
      expect(yield* approve(threadScope("agent"), "approved")).toContain("already started");

      expect(
        yield* sql<{
          actor: string;
          profile: string;
          target: string;
          outcome: string;
          decision_id: string | null;
        }>`
        SELECT actor, profile, target, outcome, decision_id FROM audit_events WHERE action = 'cloud.launch' ORDER BY id`,
      ).toEqual([
        {
          actor: "thread:person",
          profile: "owner",
          target: "cursorCloud@local",
          outcome: "person_request",
          decision_id: null,
        },
        {
          actor: "thread:agent",
          profile: "owner",
          target: "cursorCloud@local",
          outcome: "decision",
          decision_id: "approved",
        },
      ]);
    }).pipe(Effect.provide(fixture("owner"))),
);

it.effect("leaves cloud launches ungated while goatclaw is off", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    const effective = yield* profiles.resolve(outside);
    yield* profiles.requireCloudApproval(outside, effective, { target: "cursorCloud@local" });
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT id FROM audit_events`).toEqual([]);
  }).pipe(Effect.provide(fixture("worker", false))),
);

it.effect("a role launch binds the child under the role's profile, narrowed by the caller", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    yield* profiles.claim(outside, {
      id: "sweeper",
      childThreadId: ThreadId.make("sweeper"),
      runtimeMode: "full-access",
      role: "issue-sweeper",
    });
    yield* seed("sweeper");
    expect(yield* profiles.resolve(threadScope("sweeper"))).toMatchObject({
      profile: { id: "worker", capabilities: BUILTIN_PERMISSION_PROFILES.worker!.capabilities },
      runtimeMode: "auto",
    });
    // A worker caller cannot start a merge manager: narrowing would drop the merge its brief asks for.
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ goatclaw: { defaultProfile: "worker" } });
    const refused = yield* profiles
      .claim(outside, {
        id: "merger",
        childThreadId: ThreadId.make("merger"),
        runtimeMode: "full-access",
        role: "merge-manager",
      })
      .pipe(Effect.flip);
    expect(refused).toMatchObject({
      code: "capability_denied",
      message: "A merge-manager launch needs pr.merge, which this caller's profile does not allow.",
    });
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT id FROM goatclaw_lane_reservations WHERE id = 'merger'`).toEqual([]);
    expect(
      yield* sql`SELECT thread_id FROM goatclaw_thread_profiles WHERE thread_id = 'merger'`,
    ).toEqual([]);
    // An owner caller can: the child holds merge-manager's capabilities, pr.merge included.
    yield* settings.updateSettings({ goatclaw: { defaultProfile: "owner" } });
    const granted = yield* profiles.claim(outside, {
      id: "merger",
      childThreadId: ThreadId.make("merger"),
      runtimeMode: "full-access",
      role: "merge-manager",
    });
    expect(granted.profile).toMatchObject({ id: "merge-manager" });
    expect(granted.profile.capabilities).toContain("pr.merge");
    const { "merge-manager": _removed, ...remaining } = (yield* settings.getSettings).goatclaw
      .profiles;
    yield* settings.updateSettings({ goatclaw: { profiles: remaining } });
    expect(
      (yield* profiles
        .claim(outside, { id: "ghost", runtimeMode: "auto", role: "merge-manager" })
        .pipe(Effect.flip)).message,
    ).toContain("merge-manager does not exist");
  }).pipe(Effect.provide(fixture("manager"))),
);

// #858: a person whose agents run under worker can still have a supervisor land pull requests.
it.effect(
  "a supervisor a worker thread launches can start a merge manager; ceilings still refuse it",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const settings = yield* ServerSettings.ServerSettingsService;
      const refusal =
        "A merge-manager launch needs pr.merge, which this caller's profile does not allow.";
      yield* seed("person", "auto");
      yield* profiles.claim(threadScope("person"), {
        id: "supervisor",
        childThreadId: ThreadId.make("supervisor"),
        runtimeMode: "auto",
        role: "supervisor",
      });
      yield* seed("supervisor", "full-access");
      // The merge manager holds what the worker caller held plus merge, under its runtime ceiling.
      expect(
        yield* profiles.claim(threadScope("supervisor"), {
          id: "merger",
          childThreadId: ThreadId.make("merger"),
          runtimeMode: "full-access",
          role: "merge-manager",
        }),
      ).toMatchObject({
        runtimeMode: "auto",
        profile: {
          id: "merge-manager",
          capabilities: [...BUILTIN_PERMISSION_PROFILES.worker!.capabilities, "pr.merge"],
        },
      });
      // The person's own thread still cannot start one.
      expect(
        (yield* profiles
          .claim(threadScope("person"), {
            id: "direct",
            runtimeMode: "auto",
            role: "merge-manager",
          })
          .pipe(Effect.flip)).message,
      ).toBe(refusal);
      // A ceiling forwarded from a worker on another machine still removes merge.
      yield* profiles.claim(outside, {
        id: "forwarded-supervisor",
        childThreadId: ThreadId.make("forwarded-supervisor"),
        runtimeMode: "full-access",
        role: "supervisor",
        forwarded: BUILTIN_PERMISSION_PROFILES.worker!,
      });
      yield* seed("forwarded-supervisor", "full-access");
      expect(
        (yield* profiles
          .claim(threadScope("forwarded-supervisor"), {
            id: "forwarded-merger",
            runtimeMode: "full-access",
            role: "merge-manager",
          })
          .pipe(Effect.flip)).message,
      ).toBe(refusal);
      // An observer cannot launch the supervisor in the first place.
      yield* settings.updateSettings({ goatclaw: { defaultProfile: "observer" } });
      yield* seed("watcher", "auto");
      expect(
        (yield* profiles
          .claim(threadScope("watcher"), {
            id: "observer-supervisor",
            childThreadId: ThreadId.make("observer-supervisor"),
            runtimeMode: "auto",
            role: "supervisor",
          })
          .pipe(Effect.flip)).message,
      ).toContain("does not allow threads.launch");
    }).pipe(Effect.provide(fixture("worker"))),
);

it.effect("role launches and bindings stop while goatclaw is off", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    const sql = yield* SqlClient.SqlClient;
    const error = yield* profiles
      .claim(outside, { id: "role", runtimeMode: "auto", role: "issue-sweeper" })
      .pipe(Effect.flip);
    expect(error.code).toBe("capability_denied");
    yield* profiles.bind(ThreadId.make("bot-turn"), "owner", "channel:owner");
    expect(yield* sql`SELECT thread_id FROM goatclaw_thread_profiles`).toEqual([]);
  }).pipe(Effect.provide(fixture("worker", false))),
);

it.effect("bind sets a thread's profile once and never replaces it", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    yield* profiles.bind(ThreadId.make("bot-turn"), "owner", "channel:owner");
    yield* profiles.bind(ThreadId.make("bot-turn"), "observer", "channel:owner");
    yield* seed("bot-turn");
    expect((yield* profiles.resolve(threadScope("bot-turn"))).profile.id).toBe("owner");
  }).pipe(Effect.provide(fixture())),
);

it.effect("counts live native subagents, nested ones included, against maxLanes", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    const sql = yield* SqlClient.SqlClient;
    yield* seed("caller", "auto");
    const native = (id: string, thread: string, status: string, child: string | null = null) =>
      sql`INSERT INTO orchestration_v2_projection_subagents
        (subagent_id, thread_id, run_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json)
        VALUES (${id}, ${thread}, ${id === "rolled" ? "run-rolled" : null}, 'node', 'codex', ${child}, 'provider_native', ${status}, '2026-10-22', '{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run-rolled', 'caller', 1, 'codex', 'rolled_back', '2026-10-22', '{}')`;
    yield* native("first", "caller", "running", "native-child");
    yield* native("nested", "native-child", "waiting");
    yield* native("done", "caller", "completed");
    yield* native("rolled", "caller", "running");
    yield* sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
      VALUES ('delegated', 'caller', 'node', 'codex', 'app_owned', 'running', '2026-10-22', '{}')`;
    // Two live natives leave one of the worker's three lanes.
    yield* profiles.claim(threadScope("caller"), { id: "lane-1", runtimeMode: "auto" });
    expect(
      (yield* profiles
        .claim(threadScope("caller"), { id: "lane-2", runtimeMode: "auto" })
        .pipe(Effect.flip)).message,
    ).toContain("at most 3 running lanes");
    yield* sql`UPDATE orchestration_v2_projection_subagents SET status = 'completed' WHERE subagent_id = 'nested'`;
    expect(
      (yield* profiles.claim(threadScope("caller"), { id: "lane-2", runtimeMode: "auto" })).enabled,
    ).toBe(true);
  }).pipe(Effect.provide(fixture())),
);

it.effect(
  "delegated descendants share the root lane budget without sharing reservation ownership",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("root", "auto");
      for (const [parent, child] of [
        ["root", "child"],
        ["child", "grandchild"],
      ]) {
        yield* profiles.claim(threadScope(parent!), {
          id: child!,
          childThreadId: ThreadId.make(child!),
          runtimeMode: "auto",
        });
        yield* seed(child!, "auto");
        yield* sql`INSERT INTO orchestration_v2_projection_subagents
        (subagent_id, thread_id, child_thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
        VALUES (${child!}, ${parent!}, ${child!}, 'node', 'codex', 'app_owned', 'running', '2026-10-23', '{}')`;
      }
      yield* profiles.claim(threadScope("grandchild"), { id: "third", runtimeMode: "auto" });
      const denied = yield* profiles
        .claim(threadScope("child"), {
          id: "fourth",
          runtimeMode: "auto",
        })
        .pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure")
        expect(denied.failure.message).toContain("permits at most 3 running lanes");
      expect(
        (yield* profiles.claim(threadScope("grandchild"), {
          id: "third",
          runtimeMode: "auto",
        })).enabled,
      ).toBe(true);
      expect(
        (yield* profiles
          .claim(threadScope("root"), {
            id: "third",
            runtimeMode: "auto",
          })
          .pipe(Effect.flip)).message,
      ).toContain("belongs to another caller");
      yield* profiles.release("third");
      expect(
        (yield* profiles.claim(threadScope("root"), {
          id: "replacement",
          runtimeMode: "auto",
        })).enabled,
      ).toBe(true);
    }).pipe(Effect.provide(fixture())),
);

it.effect("native subagent limits follow the thread's live profile and fail closed", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    const settings = yield* ServerSettings.ServerSettingsService;
    expect(yield* profiles.nativeSubagentLimit(ThreadId.make("unbound"))).toBe(6);
    // A child bound under owner by a manager caller keeps the manager's lane ceiling.
    yield* profiles.claim(outside, {
      id: "child",
      childThreadId: ThreadId.make("child"),
      runtimeMode: "full-access",
      role: "supervisor",
    });
    expect(yield* profiles.nativeSubagentLimit(ThreadId.make("child"))).toBe(6);
    const policy = (yield* settings.getSettings).goatclaw;
    yield* settings.updateSettings({
      goatclaw: {
        ...policy,
        profiles: { ...policy.profiles, owner: { ...policy.profiles.owner!, maxLanes: 2 } },
      },
    });
    expect(yield* profiles.nativeSubagentLimit(ThreadId.make("child"))).toBe(2);
    const { owner: _removed, ...remaining } = (yield* settings.getSettings).goatclaw.profiles;
    yield* settings.updateSettings({ goatclaw: { profiles: remaining } });
    expect(yield* profiles.nativeSubagentLimit(ThreadId.make("child"))).toBe(0);
    yield* settings.updateSettings({ goatclaw: { enabled: false } });
    expect(yield* profiles.nativeSubagentLimit(ThreadId.make("child"))).toBeUndefined();
  }).pipe(Effect.provide(fixture("manager"))),
);

it.effect(
  "counts native lanes under delegated children and keeps the narrower live lane ceiling",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* seed("root", "auto");
      yield* profiles.claim(threadScope("root"), {
        id: "child",
        childThreadId: ThreadId.make("child"),
        runtimeMode: "auto",
      });
      yield* seed("child", "auto");
      yield* sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id, thread_id, child_thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
      VALUES ('delegated', 'root', 'child', 'node', 'codex', 'app_owned', 'running', '2026-10-23', '{}'),
             ('native', 'child', 'native-child', 'node', 'codex', 'provider_native', 'running', '2026-10-23', '{}'),
             ('nested', 'native-child', NULL, 'node', 'codex', 'provider_native', 'waiting', '2026-10-23', '{}')`;
      for (const caller of ["root", "child"]) {
        expect(
          (yield* profiles
            .claim(threadScope(caller), { id: `extra:${caller}`, runtimeMode: "auto" })
            .pipe(Effect.flip)).message,
        ).toContain("permits at most 3 running lanes");
      }
      yield* sql`UPDATE orchestration_v2_projection_subagents SET status = 'completed' WHERE subagent_id IN ('native', 'nested')`;
      const policy = (yield* settings.getSettings).goatclaw;
      yield* settings.updateSettings({
        goatclaw: {
          profiles: { ...policy.profiles, worker: { ...policy.profiles.worker!, maxLanes: 1 } },
        },
      });
      expect(
        (yield* profiles
          .claim(threadScope("child"), { id: "narrowed", runtimeMode: "auto" })
          .pipe(Effect.flip)).message,
      ).toContain("permits at most 1 running lanes");
      yield* seed("unrelated", "auto");
      expect(
        (yield* profiles.claim(threadScope("unrelated"), { id: "unrelated", runtimeMode: "auto" }))
          .enabled,
      ).toBe(true);
    }).pipe(Effect.provide(fixture())),
);

it.effect("refuses cyclic delegation ancestry without admitting another lane", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    const sql = yield* SqlClient.SqlClient;
    yield* seed("a", "auto");
    yield* sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id, thread_id, child_thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
      VALUES ('a-to-b', 'a', 'b', 'node', 'codex', 'app_owned', 'running', '2026-10-23', '{}'),
             ('b-to-a', 'b', 'a', 'node', 'codex', 'app_owned', 'running', '2026-10-23', '{}')`;
    expect(
      (yield* profiles
        .claim(threadScope("a"), { id: "cycle", runtimeMode: "auto" })
        .pipe(Effect.flip)).code,
    ).toBe("capability_denied");
    expect(yield* sql`SELECT id FROM goatclaw_lane_reservations`).toEqual([]);
  }).pipe(Effect.provide(fixture())),
);

// #855: the profile a thread is bound under may allow what its launch ceiling does not.
it.effect("names the ceiling that refused, not the stored profile it narrowed", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    yield* profiles.claim(outside, {
      id: "forwarded",
      childThreadId: ThreadId.make("forwarded"),
      runtimeMode: "full-access",
      forwarded: BUILTIN_PERMISSION_PROFILES.worker!,
    });
    yield* seed("forwarded");
    expect(yield* profiles.check(threadScope("forwarded"), "threads.remote")).toEqual({
      ok: false,
      reason: "Ceiling worker (narrowing manager) does not allow threads.remote.",
    });
    yield* seed("unbound");
    expect(yield* profiles.check(threadScope("unbound"), "hub.manage")).toEqual({
      ok: false,
      reason: "Profile manager does not allow hub.manage.",
    });
    const view = yield* profiles.resolve(threadScope("forwarded"));
    expect(view.profile.id).toBe("manager");
  }).pipe(Effect.provide(fixture("manager"))),
);

// A ceiling that allows what the snapshot refuses, wholly or for that field, must not be blamed.
it.effect.each([
  { name: "wider", forwarded: BUILTIN_PERMISSION_PROFILES.owner! },
  { name: "mixed", forwarded: { ...BUILTIN_PERMISSION_PROFILES.owner!, maxLanes: 3 } },
])(
  "blames the launch snapshot, not a $name forwarded ceiling, once the profile widens",
  ({ name, forwarded }) =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* profiles.claim(outside, {
        id: name,
        childThreadId: ThreadId.make(name),
        runtimeMode: "full-access",
        forwarded,
      });
      const policy = (yield* settings.getSettings).goatclaw;
      const manager = policy.profiles.manager!;
      yield* settings.updateSettings({
        goatclaw: {
          ...policy,
          profiles: {
            ...policy.profiles,
            manager: { ...manager, capabilities: [...manager.capabilities, "hub.manage"] },
          },
        },
      });
      yield* seed(name);
      expect(yield* profiles.check(threadScope(name), "hub.manage")).toEqual({
        ok: false,
        reason: "Profile manager as this thread was launched with it does not allow hub.manage.",
      });
    }).pipe(Effect.provide(fixture("manager"))),
);
