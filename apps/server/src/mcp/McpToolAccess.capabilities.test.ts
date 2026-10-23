import { expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { type AgentSurfaceEntry, agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { listedToolName } from "@goat/contracts/agentSurface/resolve";
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
import { serveOverHttp } from "./agentSurface.testkit.ts";
import { DEPRECATED_META_KEY } from "./ToolDispatch.ts";
import { NodeHttpServer } from "@effect/platform-node";

const writes = (
  Object.values(agentSurfaceRegistry) as ReadonlyArray<
    AgentSurfaceEntry & { readonly path: string; readonly legacyNames: ReadonlyArray<string> }
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
const probes = writes.map((entry) =>
  Tool.make(entry.name, {
    ...result,
    ...(entry.hostRoutable
      ? { parameters: Schema.Struct({ host: Schema.optional(Schema.String) }) }
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
  observer: 48,
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
        const outcome = yield* call(listedToolName(entry), threadCaller(caller));
        if (capability === "none" || profile.capabilities.includes(capability)) {
          expect(outcome, entry.path).toEqual({ ran: entry.name });
          allowed += 1;
        } else expect(outcome, entry.path).toMatchObject(refusedFor(capability));
        expect(yield* call(listedToolName(entry), outside), entry.path).toEqual({
          ran: entry.name,
        });
      }
      expect(allowed).toBe(ALLOWED_WRITES[id]);
    }).pipe(Effect.provide(served({ enabled: true, defaultProfile: id }))),
);

it.effect("changes nothing with goatclaw off", () =>
  Effect.gen(function* () {
    for (const entry of writes)
      expect(yield* call(listedToolName(entry), threadCaller(caller)), entry.path).toEqual({
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
    expect(yield* call(listedToolName(send), threadCaller(caller), { host: "box" })).toEqual({
      ran: send.name,
    });
    expect(
      yield* call(listedToolName(send), threadCaller(caller), { host: "other" }),
    ).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("host other"),
    });
    yield* settings.updateSettings({ goatclaw: { ...policy, defaultProfile: "worker" } });
    expect(yield* call(listedToolName(send), threadCaller(caller), { host: "box" })).toMatchObject(
      refusedFor("threads.remote"),
    );
    expect(yield* call(listedToolName(send), threadCaller(caller))).toEqual({ ran: send.name });
  }).pipe(Effect.provide(served({ enabled: true, defaultProfile: "manager" }))),
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
    expect(yield* call(listedToolName(launch), threadCaller(child))).toEqual({ ran: launch.name });
    expect(yield* call(listedToolName(settingsWrite), threadCaller(child))).toMatchObject(
      refusedFor("settings.write"),
    );
    expect(yield* call(listedToolName(remote), threadCaller(child))).toMatchObject(
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
    expect(yield* call(listedToolName(destroy), undefined)).toEqual({ ran: destroy.name });
  }).pipe(Effect.provide(served({ enabled: true, defaultProfile: "observer" }))),
);

it.effect("refuses a nested call the same way as a direct one", () =>
  Effect.gen(function* () {
    yield* seed(caller);
    const destroy = entryAt("project.delete");
    const direct = yield* call(listedToolName(destroy), threadCaller(caller));
    expect(direct).toMatchObject(refusedFor("settings.write"));
    const nested = yield* call("nested_call", threadCaller(caller), {
      tool: listedToolName(destroy),
    });
    expect("ran" in nested && JSON.parse(nested.ran)).toMatchObject(direct);
  }).pipe(Effect.provide(served({ enabled: true, defaultProfile: "observer" }))),
);

it.effect("gates a legacy tool name over /mcp exactly as its listed name", () =>
  Effect.gen(function* () {
    const observer = BUILTIN_PERMISSION_PROFILES.observer!;
    const entry = writes.find(
      (candidate) =>
        candidate.legacyNames.length > 0 &&
        candidate.capability !== "none" &&
        !observer.capabilities.includes(candidate.capability!),
    )!;
    const http = yield* serveOverHttp(
      { thread: threadCaller(caller), outside },
      Layer.effectDiscard(seed(caller)).pipe(
        Layer.provideMerge(served({ enabled: true, defaultProfile: "observer" })),
      ),
    );
    const outcome = (result: McpSchema.CallToolResult) => decodeOutcome(textOf(result.content));
    const [legacy] = entry.legacyNames;
    const byLegacy = yield* http.callTool("thread", legacy!, {});
    const byListed = yield* http.callTool("thread", listedToolName(entry), {});
    expect(yield* outcome(byListed), entry.path).toMatchObject(refusedFor(entry.capability!));
    expect(yield* outcome(byLegacy), entry.path).toEqual(yield* outcome(byListed));
    expect(byLegacy._meta?.[DEPRECATED_META_KEY]).toBe(listedToolName(entry));
    // An outside client is bounded by its approved access, under either name.
    expect(yield* outcome(yield* http.callTool("outside", legacy!, {}))).toEqual({
      ran: entry.name,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
