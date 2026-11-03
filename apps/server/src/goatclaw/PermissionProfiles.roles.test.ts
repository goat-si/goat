import { expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { requireDeclaredCapability } from "../mcp/McpToolAccess.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PermissionProfiles, layer } from "./PermissionProfiles.ts";

const outside: McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "role-grants",
  thread: undefined,
  client: { sessionId: "role-grants", label: "test", access: "full-access" },
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
const fixture = (profile: string) =>
  layer.pipe(
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(
      ServerSettings.layerTest({ goatclaw: { enabled: true, defaultProfile: profile } }),
    ),
  );
const seed = (id: string, mode: RuntimeMode) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${id}, 'project', 'Test', 'codex', ${mode}, 'default', '2026-10-25', '2026-10-25', '{}')`,
    ),
  );
const { manager, worker } = BUILTIN_PERMISSION_PROFILES;
const mergeManager = BUILTIN_PERMISSION_PROFILES["merge-manager"]!;

it.effect.each(["pull_request.merge", "pull_request.close"] as const)(
  "#2194: a supervisor can launch a merge manager but cannot directly call %s",
  (path) =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      yield* seed("person", "auto");
      yield* profiles.claim(threadScope("person"), {
        id: "supervisor",
        childThreadId: ThreadId.make("supervisor"),
        runtimeMode: "auto",
        role: "supervisor",
      });
      yield* seed("supervisor", "auto");
      expect(
        (yield* profiles.claim(threadScope("supervisor"), {
          id: "merger",
          runtimeMode: "auto",
          role: "merge-manager",
        })).profile.capabilities,
      ).toContain("pr.merge");
      const direct = requireDeclaredCapability(profiles, path, "write", {}).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, threadScope("supervisor")),
        Effect.match({ onFailure: (error) => error.code, onSuccess: () => "admitted" }),
      );
      expect(yield* direct).toBe("capability_denied");
      yield* profiles.assertTarget(
        threadScope("person"),
        ThreadId.make("supervisor"),
        "auto",
        "auto",
      );
      yield* profiles.claim(threadScope("person"), {
        id: "resume",
        childThreadId: ThreadId.make("supervisor"),
        runtimeMode: "auto",
      });
      expect(yield* direct).toBe("capability_denied");
    }).pipe(Effect.provide(fixture("worker"))),
);

it.effect("#2194: an ordinary owner retains direct PR writes", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    yield* profiles.claim(outside, {
      id: "owner-thread",
      childThreadId: ThreadId.make("owner"),
      runtimeMode: "full-access",
    });
    yield* seed("owner", "full-access");
    const result = yield* requireDeclaredCapability(
      profiles,
      "pull_request.merge",
      "write",
      {},
    ).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, threadScope("owner")),
      Effect.match({ onFailure: (error) => error.code, onSuccess: () => "admitted" }),
    );
    expect(result).toBe("admitted");
    yield* profiles.claim(threadScope("owner"), {
      id: "owner-supervisor",
      childThreadId: ThreadId.make("owner-supervisor"),
      runtimeMode: "full-access",
      role: "supervisor",
    });
    yield* seed("owner-supervisor", "full-access");
    const supervisorResult = yield* requireDeclaredCapability(
      profiles,
      "pull_request.merge",
      "write",
      {},
    ).pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        threadScope("owner-supervisor"),
      ),
      Effect.match({ onFailure: (error) => error.code, onSuccess: () => "admitted" }),
    );
    expect(supervisorResult).toBe("capability_denied");
  }).pipe(Effect.provide(fixture("owner"))),
);

it.effect("#2194: a supervisor can launch a merge manager locally and over SSH", () =>
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    yield* seed("manager", "full-access");
    yield* profiles.claim(threadScope("manager"), {
      id: "supervisor",
      childThreadId: ThreadId.make("supervisor"),
      runtimeMode: "full-access",
      role: "supervisor",
    });
    yield* seed("supervisor", "full-access");
    for (const [path, host] of [
      ["thread.launch", undefined],
      ["ssh.thread_launch", "box"],
    ] as const) {
      yield* requireDeclaredCapability(profiles, path, "write", { host }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, threadScope("supervisor")),
      );
      const launch = { id: path, runtimeMode: "full-access", role: "merge-manager", host } as const;
      const granted = yield* profiles.claim(threadScope("supervisor"), launch);
      expect(granted.profile.capabilities).toContain("pr.merge");
      yield* profiles.recheck(threadScope("supervisor"), granted, { role: "merge-manager", host });
    }
  }).pipe(Effect.provide(fixture("manager"))),
);

// #858: goat_ssh_thread_launch claims a supervisor, then rechecks right before the remote launch.
it.effect(
  "an SSH supervisor launch passes its recheck until its profile or a ceiling narrows",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const settings = yield* ServerSettings.ServerSettingsService;
      const launch = { host: "box", runtimeMode: "full-access", role: "supervisor" } as const;
      const recheck = { host: "box", role: "supervisor" } as const;
      // manager reaches other machines but cannot merge; the supervisor keeps pr.merge.
      const admitted = yield* profiles.claim(outside, { ...launch, id: "unchanged" });
      expect(admitted.profile.capabilities).toContain("pr.merge");
      yield* profiles.recheck(outside, admitted, recheck);
      // A forwarded ceiling that allowed merge at the claim and no longer does by the recheck.
      const forwarded = yield* profiles.claim(outside, {
        ...launch,
        id: "forwarded",
        forwarded: mergeManager,
      });
      yield* profiles.recheck(outside, forwarded, { ...recheck, forwarded: mergeManager });
      expect(
        (yield* profiles
          .recheck(outside, forwarded, { ...recheck, forwarded: manager })
          .pipe(Effect.flip)).message,
      ).toContain("narrowed");
      // The supervisor's own profile stops allowing merge.
      const policy = (yield* settings.getSettings).goatclaw;
      const owner = policy.profiles.owner!;
      yield* settings.updateSettings({
        goatclaw: {
          ...policy,
          profiles: {
            ...policy.profiles,
            owner: { ...owner, capabilities: owner.capabilities.filter((c) => c !== "pr.merge") },
          },
        },
      });
      expect(
        (yield* profiles.recheck(outside, admitted, recheck).pipe(Effect.flip)).message,
      ).toContain("narrowed");
    }).pipe(Effect.provide(fixture("manager"))),
);

it.effect(
  "the thread that launched a supervisor can resume it and it can still merge; a ceiling without merge cannot send",
  () =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      yield* seed("person", "auto");
      const supervisor = ThreadId.make("supervisor");
      yield* profiles.claim(threadScope("person"), {
        id: "supervisor",
        childThreadId: supervisor,
        runtimeMode: "auto",
        role: "supervisor",
      });
      yield* seed("supervisor", "auto");
      // What sendToThread does to resume an idle thread: check the target, then claim its lane.
      yield* profiles.assertTarget(threadScope("person"), supervisor, "auto", "auto");
      yield* profiles.claim(threadScope("person"), {
        id: "resume",
        childThreadId: supervisor,
        runtimeMode: "auto",
      });
      expect(
        (yield* profiles.claim(threadScope("supervisor"), {
          id: "merger",
          runtimeMode: "auto",
          role: "merge-manager",
        })).profile.capabilities,
      ).toContain("pr.merge");
      yield* profiles.assertTarget(threadScope("person"), supervisor, "auto", "auto");
      expect(
        (yield* profiles
          .assertTarget(outside, supervisor, "auto", "auto", worker)
          .pipe(Effect.flip)).message,
      ).toContain("exceeds the caller's ceiling");
    }).pipe(Effect.provide(fixture("worker"))),
);
