import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  Project,
  EnvironmentAuthorizationError,
  AuthSessionId,
  ThreadId,
  OrchestratorMcpFailure,
  type ServerSettings,
  type ProjectEntry,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Workspace from "./AgentWorkspaceMcpService.ts";
import * as Access from "./AgentWorkspaceTerminalAccess.ts";
import * as Audit from "./AgentWorkspaceTerminalAudit.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFiles from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as Settings from "../serverSettings.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { layerPermissionProfilesOff, liveThreadShell } from "./McpToolAccess.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as TerminalService from "./AgentTerminalMcpService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { FakePtyAdapter } from "../terminal/Manager.testkit.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
const decodeProject = Schema.decodeEffect(Project);

export const fixture = Effect.fn("agentWorkspaceTerminal.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-agent-workspace-" });
  const outside = yield* fs.makeTempDirectoryScoped({ prefix: "goat-agent-outside-" });
  const settings = yield* Ref.make<ServerSettings>({
    ...DEFAULT_SERVER_SETTINGS,
    agentWorkspaceAccess: "read_write" as const,
  });
  const grants = yield* Ref.make<ReadonlyArray<AuthEnvironmentScope>>([
    "filesystem:read",
    "filesystem:write",
  ]);
  const projectId = ProjectId.make("fixture-project");
  const environmentId = EnvironmentId.make("fixture-environment");
  const project = yield* decodeProject({
    id: projectId,
    title: "Fixture",
    workspaceRoot: root,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  });
  const events: Array<{ action: string; target: string; outcome: string }> = [];
  const auditOnline = yield* Ref.make(true);
  const scope: McpInvocationScope = {
    environmentId,
    issuedAt: 0,
    requestNamespace: "fixture-client",
    capabilities: new Set(["orchestration"]),
    grantedScopes: ["filesystem:read", "filesystem:write"],
    thread: undefined,
    client: { sessionId: "fixture-client", label: "Fixture", access: "full-access" },
    reauthorize: (required) =>
      Ref.get(grants).pipe(
        Effect.flatMap((held) =>
          required.every((permission) => held.includes(permission))
            ? Effect.void
            : Effect.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: required[0] ?? "filesystem:read",
                  message: "Revoked fixture grant.",
                }),
              ),
        ),
      ),
  };
  const listed = yield* Ref.make<ReadonlyArray<ProjectEntry>>([
    { path: "draft.txt", kind: "file" },
  ]);
  const entries = Layer.mock(WorkspaceEntries.WorkspaceEntries)({
    refresh: () => Effect.void,
    list: () => Ref.get(listed).pipe(Effect.map((entries) => ({ entries, truncated: false }))),
    search: () =>
      Effect.succeed({
        entries: [
          { path: "escape/secret.txt", kind: "file" as const },
          { path: "draft.txt", kind: "file" as const },
        ],
        truncated: false,
      }),
  });
  const audit = Layer.succeed(Audit.AgentWorkspaceTerminalAudit, {
    append: (_scope, action, target, outcome) =>
      Ref.get(auditOnline).pipe(
        Effect.flatMap((online) =>
          online
            ? Effect.sync(() => {
                events.push({ action, target, outcome });
              })
            : Effect.fail(
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "Audit unavailable.",
                }),
              ),
        ),
      ),
  });
  const baseServices = Layer.mergeAll(
    entries,
    audit,
    Layer.mock(Settings.ServerSettingsService)({ getSettings: Ref.get(settings) }),
    Layer.mock(Projects.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
    Layer.mock(Environment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), projectId }),
    }),
  );
  const base = Layer.merge(baseServices, layerPermissionProfilesOff);
  const files = WorkspaceFiles.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(entries),
    Layer.provide(
      Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
    ),
  );
  const built = yield* Layer.build(
    Workspace.layer.pipe(Layer.provide(files), Layer.provide(Access.layer), Layer.provide(base)),
  );
  return {
    root,
    outside,
    fs,
    scope,
    projectId,
    grants,
    settings,
    events,
    auditOnline,
    base,
    baseServices,
    listed,
    service: Context.get(built, Workspace.AgentWorkspaceMcpService),
  };
});

export const terminalFixture = Effect.fn("agentWorkspaceTerminal.terminalFixture")(function* () {
  const f = yield* fixture();
  const threadId = ThreadId.make("fixture-thread");
  yield* Ref.update(f.settings, (settings) => ({
    ...settings,
    agentTerminalAccess: "operate" as const,
    agentTerminalClientBindings: {
      [AuthSessionId.make("fixture-client")]: { threadId, generation: "binding-a" },
      [AuthSessionId.make("fixture-other")]: { threadId, generation: "binding-b" },
    },
  }));
  const permissions: ReadonlyArray<AuthEnvironmentScope> = [
    "filesystem:read",
    "filesystem:write",
    "terminal:read",
    "terminal:operate",
  ];
  yield* Ref.set(f.grants, permissions);
  const scope = { ...f.scope, grantedScopes: permissions };
  const pty = new FakePtyAdapter();
  const manager = yield* TerminalManager.makeWithOptions({
    logsDir: `${f.root}/terminal-logs`,
    historyLineLimit: 10,
    historyByteLimit: 64,
    shellResolver: () => "/bin/sh",
    ptyAdapter: pty,
    processTable: Effect.succeed([]),
    subprocessInspector: () =>
      Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
    processKillGraceMs: 1,
    subprocessPollIntervalMs: 10 * 24 * 60 * 60 * 1000,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Layer.mock(ProcessRunner.ProcessRunner)({}), McpProviderSessions.layer),
    ),
  );
  const built = yield* Layer.build(
    TerminalService.layer.pipe(
      Layer.provide(Access.layer),
      Layer.provide(f.base),
      Layer.provide(Layer.succeed(TerminalManager.TerminalManager, manager)),
    ),
  );
  return {
    ...f,
    scope,
    manager,
    pty,
    threadId,
    terminal: Context.get(built, TerminalService.AgentTerminalMcpService),
  };
});
