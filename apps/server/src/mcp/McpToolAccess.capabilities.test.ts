import { expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { type AgentSurfaceEntry, agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { hostArgumentsOf } from "@goat/contracts/agentSurface/hosts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadsLayer } from "./McpToolAccess.testkit.ts";

const writes = (
  Object.values(agentSurfaceRegistry) as ReadonlyArray<
    AgentSurfaceEntry & { readonly path: string }
  >
).filter((entry) => entry.effect !== "read");
const entryAt = (path: string) => writes.find((entry) => entry.path === path)!;

const result = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
};
// One probe per registered write. Declared as reads on purpose: the gate must follow the
// registry entry, not the handler's own declaration.
const hostKeys = hostArgumentsOf;
const probes = writes.map((entry) =>
  Tool.make(entry.name, {
    ...result,
    ...(hostKeys(entry).length > 0
      ? {
          parameters: Schema.Struct(
            Object.fromEntries(hostKeys(entry).map((key) => [key, Schema.optional(Schema.String)])),
          ),
        }
      : {}),
  }),
);
const ProbeToolkit = Toolkit.make(
  ...probes,
  Tool.make("unregistered_write", {
    ...result,
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  }),
  Tool.make("nested_call", {
    ...result,
    parameters: Schema.Struct({ tool: Schema.String }),
    dependencies: [McpServer.McpServer],
  }),
);

const textOf = (content: ReadonlyArray<McpSchema.ContentBlock>) =>
  content.map((part) => (part.type === "text" ? part.text : "")).join("");

const handlers = {
  ...Object.fromEntries(
    writes.map((entry) => [
      entry.name,
      McpToolAccess.reads(() => Effect.succeed({ ran: entry.name })),
    ]),
  ),
  unregistered_write: McpToolAccess.writesWithCapability(() =>
    Effect.succeed({ ran: "unregistered_write" }),
  ),
  // What goat_call's ToolDispatch does: call another tool through the same server.
  nested_call: McpToolAccess.reads(({ tool }: { readonly tool: string }) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name: tool, arguments: {} })),
      Effect.map(({ content }) => ({ ran: textOf(content) })),
      Effect.orDie,
    ),
  ),
} as unknown as McpToolAccess.Handlers<typeof ProbeToolkit.tools>;

const served = (goatclaw: { readonly enabled: boolean; readonly defaultProfile: string }) =>
  McpHttpServer.toolkitRegistration(
    ProbeToolkit,
    McpToolAccess.toLayer(ProbeToolkit, handlers),
  ).pipe(
    Layer.provideMerge(Profiles.layer),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(liveThreadsLayer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest({ goatclaw })),
  );

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "capability-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "capability-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const outside: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "GOAT SSH dispatch", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const seed = (threadId: ThreadId) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${threadId}, 'project', 'Test', 'codex', 'full-access', 'default', '2026-10-23', '2026-10-23', '{}')`,
    ),
  );

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ ran: Schema.String }),
      Schema.Struct({ code: Schema.String, message: Schema.String }),
    ]),
  ),
);

const call = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope | undefined,
  args: Record<string, unknown> = {},
) => {
  const called = McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
    Effect.flatMap(({ content }) => decodeOutcome(textOf(content))),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );
  return scope === undefined
    ? called
    : called.pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));
};

const refusedFor = (capability: string) => ({
  code: "capability_denied",
  message: expect.stringContaining(`needs the goatclaw ${capability} capability`),
});

const caller = ThreadId.make("thread:caller");

// Writes each built-in profile may run: the declared mapping's effect, pinned for review.
const ALLOWED_WRITES: Readonly<Record<string, number>> = {
  observer: 51,
  worker: 83,
  manager: 97,
  "merge-manager": 97,
  owner: 129,
};

it.effect.each(Object.keys(BUILTIN_PERMISSION_PROFILES))(
  "gates every write from a %s thread by its declared capability, and no outside client",
  (id) =>
    Effect.gen(function* () {
      yield* seed(caller);
      const profile = BUILTIN_PERMISSION_PROFILES[id]!;
      let allowed = 0;
      for (const entry of writes) {
        const capability = entry.capability!;
        const outcome = yield* call(entry.name, threadCaller(caller));
        if (capability === "none" || profile.capabilities.includes(capability)) {
          expect(outcome, entry.path).toEqual({ ran: entry.name });
          allowed += 1;
        } else expect(outcome, entry.path).toMatchObject(refusedFor(capability));
        expect(yield* call(entry.name, outside), entry.path).toEqual({ ran: entry.name });
      }
      expect(allowed).toBe(ALLOWED_WRITES[id]);
    }).pipe(Effect.provide(served({ enabled: true, defaultProfile: id }))),
);

it.effect("changes nothing with goatclaw off", () =>
  Effect.gen(function* () {
    for (const entry of writes)
      expect(yield* call(entry.name, threadCaller(caller)), entry.path).toEqual({
        ran: entry.name,
      });
    expect(yield* call("unregistered_write", threadCaller(caller))).toEqual({
      ran: "unregistered_write",
    });
  }).pipe(Effect.provide(served({ enabled: false, defaultProfile: "observer" }))),
);

it.effect("needs threads.remote and an allowed host for a write that names a host", () =>
  Effect.gen(function* () {
    yield* seed(caller);
    const settings = yield* ServerSettings.ServerSettingsService;
    const policy = (yield* settings.getSettings).goatclaw;
    yield* settings.updateSettings({
      goatclaw: {
        ...policy,
        profiles: { ...policy.profiles, manager: { ...policy.profiles.manager!, hosts: ["box"] } },
      },
    });
    const send = entryAt("thread.send");
    expect(send).toMatchObject({ hostRoutable: true, capability: "threads.launch" });
    expect(yield* call(send.name, threadCaller(caller), { host: "box" })).toEqual({
      ran: send.name,
    });
    expect(yield* call(send.name, threadCaller(caller), { host: "other" })).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("host other"),
    });
    yield* settings.updateSettings({ goatclaw: { ...policy, defaultProfile: "worker" } });
    expect(yield* call(send.name, threadCaller(caller), { host: "box" })).toMatchObject(
      refusedFor("threads.remote"),
    );
    expect(yield* call(send.name, threadCaller(caller))).toEqual({ ran: send.name });
  }).pipe(Effect.provide(served({ enabled: true, defaultProfile: "manager" }))),
);

const limitProfileTo = (id: string, hosts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const policy = (yield* settings.getSettings).goatclaw;
    yield* settings.updateSettings({
      goatclaw: {
        ...policy,
        profiles: { ...policy.profiles, [id]: { ...policy.profiles[id]!, hosts } },
      },
    });
    return { settings, policy };
  });

// #856: a host-routed write without a capability of its own still reaches another machine.
it.effect(
  "holds a host-routed write that declares no capability to threads.remote and the allowlist",
  () =>
    Effect.gen(function* () {
      yield* seed(caller);
      const { settings, policy } = yield* limitProfileTo("manager", ["box"]);
      for (const path of ["thread.watch", "thread.unwatch"]) {
        const watch = entryAt(path);
        expect(watch).toMatchObject({ hostRoutable: true, capability: "none" });
        expect(yield* call(watch.name, threadCaller(caller), { host: "box" })).toEqual({
          ran: watch.name,
        });
        expect(yield* call(watch.name, threadCaller(caller), { host: "other" })).toEqual({
          code: "capability_denied",
          message: `${watch.name} acts on host other, which needs the goatclaw threads.remote capability and a host the profile allows. Profile manager does not allow host other.`,
        });
      }
      yield* settings.updateSettings({ goatclaw: { ...policy, defaultProfile: "worker" } });
      const watch = entryAt("thread.watch");
      expect(yield* call(watch.name, threadCaller(caller), { host: "box" })).toMatchObject(
        refusedFor("threads.remote"),
      );
      expect(yield* call(watch.name, threadCaller(caller))).toEqual({ ran: watch.name });
    }).pipe(Effect.provide(served({ enabled: true, defaultProfile: "manager" }))),
);

// #805, #857: these writes name the machine they act on outside a routing `host`.
it.effect("applies the host allowlist to every argument a write declares names a host", () =>
  Effect.gen(function* () {
    yield* seed(caller);
    // Owner holds every capability, so only the host decides.
    yield* limitProfileTo("owner", ["box"]);
    const declared = writes.filter((entry) => !entry.hostRoutable && hostKeys(entry).length > 0);
    expect(declared.map((entry) => entry.path).toSorted()).toEqual([
      "channel.task_move",
      "host.cordon",
      "host.drain",
      "host.uncordon",
      "hub.device_join",
      "hub.device_leave",
      "hub.device_repair",
      "ssh.host_forget",
      "ssh.host_prepare",
      "ssh.runtime_update",
      "thread.handoff_host",
      "thread.replication_set",
      "thread.reschedule",
    ]);
    for (const entry of declared) {
      const keys = hostKeys(entry);
      const allowed = Object.fromEntries(keys.map((key) => [key, "box"]));
      expect(yield* call(entry.name, threadCaller(caller), allowed), entry.path).toEqual({
        ran: entry.name,
      });
      for (const key of keys)
        expect(
          yield* call(entry.name, threadCaller(caller), { ...allowed, [key]: "other" }),
          `${entry.path} ${key}`,
        ).toMatchObject({
          code: "capability_denied",
          message: expect.stringContaining("Profile owner does not allow host other."),
        });
    }
  }).pipe(Effect.provide(served({ enabled: true, defaultProfile: "owner" }))),
);

// hub.manage alone checks the allowlist in HubMembership; the machine still needs threads.remote.
it.effect("holds hub device writes to threads.remote for the device they name", () =>
  Effect.gen(function* () {
    yield* seed(caller);
    const settings = yield* ServerSettings.ServerSettingsService;
    const policy = (yield* settings.getSettings).goatclaw;
    const owner = policy.profiles.owner!;
    yield* settings.updateSettings({
      goatclaw: {
        ...policy,
        profiles: {
          ...policy.profiles,
          owner: {
            ...owner,
            capabilities: owner.capabilities.filter((capability) => capability !== "threads.remote"),
          },
        },
      },
    });
    for (const path of ["hub.device_join", "hub.device_leave", "hub.device_repair"]) {
      const entry = entryAt(path);
      expect(entry.capability).toBe("hub.manage");
      expect(yield* call(entry.name, threadCaller(caller), { deviceAlias: "box" })).toEqual({
        code: "capability_denied",
        message: `${entry.name} acts on host box, which needs the goatclaw threads.remote capability and a host the profile allows. Profile owner does not allow threads.remote.`,
      });
    }
  }).pipe(Effect.provide(served({ enabled: true, defaultProfile: "owner" }))),
);

it.effect("holds a thread launched with a forwarded ceiling to that ceiling", () =>
  Effect.gen(function* () {
    // What a destination does for a launch forwarded by a worker-profiled caller on another host.
    const child = ThreadId.make("thread:forwarded-child");
    yield* seed(child);
    yield* (yield* Profiles.PermissionProfiles).claim(outside, {
      id: "lane:forwarded",
      childThreadId: child,
      runtimeMode: "full-access",
      forwarded: BUILTIN_PERMISSION_PROFILES.worker!,
    });
    const launch = entryAt("thread.send");
    const settingsWrite = entryAt("environment.preferences_update");
    const remote = entryAt("ssh.thread_launch");
    expect(yield* call(launch.name, threadCaller(child))).toEqual({ ran: launch.name });
    expect(yield* call(settingsWrite.name, threadCaller(child))).toMatchObject(
      refusedFor("settings.write"),
    );
    expect(yield* call(remote.name, threadCaller(child))).toMatchObject(
      refusedFor("threads.remote"),
    );
  }).pipe(Effect.provide(served({ enabled: true, defaultProfile: "manager" }))),
);

it.effect("refuses an unregistered write from a thread and passes a call without a caller", () =>
  Effect.gen(function* () {
    yield* seed(caller);
    expect(yield* call("unregistered_write", threadCaller(caller))).toMatchObject({
      code: "capability_denied",
      message: "unregistered_write declares no goatclaw capability.",
    });
    const destroy = entryAt("project.delete");
    expect(yield* call(destroy.name, undefined)).toEqual({ ran: destroy.name });
  }).pipe(Effect.provide(served({ enabled: true, defaultProfile: "observer" }))),
);

it.effect("refuses a nested call the same way as a direct one", () =>
  Effect.gen(function* () {
    yield* seed(caller);
    const destroy = entryAt("project.delete");
    const direct = yield* call(destroy.name, threadCaller(caller));
    expect(direct).toMatchObject(refusedFor("settings.write"));
    const nested = yield* call("nested_call", threadCaller(caller), { tool: destroy.name });
    expect("ran" in nested && JSON.parse(nested.ran)).toMatchObject(direct);
  }).pipe(Effect.provide(served({ enabled: true, defaultProfile: "observer" }))),
);
