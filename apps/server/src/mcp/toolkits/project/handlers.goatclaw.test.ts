import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { listedToolName } from "@goat/contracts/agentSurface/resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import * as ThreadLaunchMcpService from "../../ThreadLaunchMcpService.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const project = {
  id: ProjectId.make("project:created"),
  title: "App",
  workspaceRoot: "/work/app",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  deletedAt: null,
};

/** What a call did; `revoke` is applied while the call is admitted, after its first check. */
interface CallState {
  mode: RuntimeMode;
  admissions: number;
  writes: number;
  readonly revoke?: "mode" | "profile";
}

/** Stands in for ToolAdmission: admitting the call revokes the caller's mode or profile. */
const revokingAdmission = (state: CallState) =>
  Layer.effect(
    McpToolAccess.KeyedAdmission,
    Effect.map(ServerSettings.ServerSettingsService, (settings) => ({
      admit: () =>
        Effect.gen(function* () {
          state.admissions += 1;
          if (state.revoke === "mode") state.mode = "approval-required";
          if (state.revoke === "profile")
            yield* settings.updateSettings({ goatclaw: { defaultProfile: "observer" } });
        }).pipe(Effect.orDie),
    })),
  );

/** The real project toolkit, served the way /mcp serves it, with goatclaw on or off. */
const served = (
  options: { readonly profile?: string; readonly mode: RuntimeMode },
  state: CallState = { mode: options.mode, admissions: 0, writes: 0 },
) =>
  McpHttpServer.toolkitRegistration(ProjectToolkit, ProjectHandlers.layer).pipe(
    Layer.provideMerge(Profiles.layer),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(state.revoke === undefined ? Layer.empty : revokingAdmission(state)),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.sync(() => liveThreadShell(threadId, { runtimeMode: state.mode })),
        }),
        Layer.mock(Project.ProjectService)({
          create: () =>
            Effect.sync(() => {
              state.writes += 1;
              return project;
            }),
          update: () => Effect.succeed(project),
          delete: () => Effect.succeed(project),
        }),
        Layer.mock(Repositories.SourceControlRepositoryService)({
          cloneRepository: (input) =>
            Effect.succeed({
              cwd: input.destinationPath,
              remoteUrl: "https://example.test/app.git",
              repository: null,
            }),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
        Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({}),
        Layer.mock(ThreadLaunchMcpService.ThreadLaunchMcpService)({}),
        Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({}),
        NodeCrypto.layer,
      ),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(
      ServerSettings.layerTest({
        goatclaw: {
          enabled: options.profile !== undefined,
          defaultProfile: options.profile ?? "worker",
        },
      }),
    ),
  );

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "project-admission-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "project-admission-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const caller = ThreadId.make("thread:worker");
const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${caller}`,
  thread: {
    threadId: caller,
    providerSessionId: `provider:${caller}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const readOnlyClient: McpInvocationContext.McpInvocationScope = {
  ...threadCaller,
  requestNamespace: "client:read-only",
  thread: undefined,
  client: { sessionId: "read-only", label: "Read-only agent", access: "read-only" },
};

/** goatclaw resolves the calling thread's live mode from its projection row. */
const seed = (mode: RuntimeMode) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${caller}, 'project', 'Test', 'codex', ${mode}, 'default', '2026-10-25', '2026-10-25', '{}')`,
    ),
  );

const calls = {
  "project.create": { title: "App", workspaceRoot: "/work/app" },
  "project.clone": { destinationPath: "/work/clone", remoteUrl: "https://example.test/app.git" },
  "project.update": { projectId: project.id, title: "Renamed" },
  "project.delete": { projectId: project.id },
} as const;

/** Runs one project tool; returns the refusal it ended in, or undefined when it ran. */
const refusalOf = (path: keyof typeof calls, scope: McpInvocationContext.McpInvocationScope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) =>
      server.callTool({ name: listedToolName(agentSurfaceRegistry[path]), arguments: calls[path] }),
    ),
    Effect.map(({ content }) => {
      const text = content.map((part) => (part.type === "text" ? part.text : "")).join("");
      const outcome = JSON.parse(text) as { readonly code?: string; readonly message?: string };
      return outcome.code === undefined ? undefined : `${outcome.code}: ${outcome.message}`;
    }),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
  );

// #858: goatclaw's worker and manager agents run at auto, and set up the projects they work in.
it.effect.each([
  { profile: "worker", mode: "auto", sets: true, changes: "settings.write" },
  { profile: "manager", mode: "auto", sets: true, changes: "settings.write" },
  // Holds settings.write, so only the runtime floor refuses its update and delete.
  { profile: "owner", mode: "auto", sets: true, changes: "full-access/default" },
  { profile: "observer", mode: "auto", sets: false, changes: "settings.write" },
  { profile: "worker", mode: "auto-accept-edits", sets: false, changes: "settings.write" },
  // goatclaw off: no profile grants the narrower floor, so a project still needs full access.
  { profile: undefined, mode: "auto", sets: false, changes: "full-access/default" },
] as const)(
  "a $profile thread at $mode sets up projects: $sets; update and delete stay refused",
  ({ profile, mode, sets, changes }) =>
    Effect.gen(function* () {
      yield* seed(mode);
      for (const path of ["project.create", "project.clone"] as const) {
        const refusal = yield* refusalOf(path, threadCaller);
        if (sets) expect(refusal, path).toBeUndefined();
        else expect(refusal, path).toMatch(/^capability_denied: /);
        // A read-only client never sets one up.
        expect(yield* refusalOf(path, readOnlyClient), path).toMatch(/^capability_denied: /);
      }
      for (const path of ["project.update", "project.delete"] as const)
        expect(yield* refusalOf(path, threadCaller), path).toMatch(
          new RegExp(`^capability_denied: .*${changes}`),
        );
    }).pipe(Effect.provide(served({ ...(profile === undefined ? {} : { profile }), mode }))),
);

// A caller's mode or profile can change while its call waits in admission.
it.effect.each(["mode", "profile"] as const)(
  "a worker whose %s is revoked while its create is admitted is refused before it writes",
  (revoke) => {
    const state: CallState = { mode: "auto", admissions: 0, writes: 0, revoke };
    return Effect.gen(function* () {
      yield* seed("auto");
      expect(yield* refusalOf("project.create", threadCaller)).toMatch(/^capability_denied: /);
      expect(state).toMatchObject({ admissions: 1, writes: 0 });
    }).pipe(Effect.provide(served({ profile: "worker", mode: "auto" }, state)));
  },
);
