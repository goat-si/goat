import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  Project,
  EnvironmentAuthorizationError,
  GoatclawSettings,
  clientRpcRequiredScopes,
  WS_METHODS,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import { McpInvocationContext } from "./McpInvocationContext.ts";
import { catalog, client, dependencies } from "./agentSurface.testkit.ts";
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
import { layerPermissionProfilesOff } from "./McpToolAccess.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { mcpClientScopes } from "../auth/mcpClientScopes.ts";
const decodeProject = Schema.decodeEffect(Project);
const decodeGoatclaw = Schema.decodeEffect(GoatclawSettings);

const fixture = Effect.fn("agentWorkspaceTerminal.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-agent-workspace-" });
  const outside = yield* fs.makeTempDirectoryScoped({ prefix: "goat-agent-outside-" });
  const settings = yield* Ref.make({
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
  const entries = Layer.mock(WorkspaceEntries.WorkspaceEntries)({
    refresh: () => Effect.void,
    list: () =>
      Effect.succeed({ entries: [{ path: "draft.txt", kind: "file" as const }], truncated: false }),
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
      Effect.sync(() => {
        events.push({ action, target, outcome });
      }),
  });
  const base = Layer.mergeAll(
    entries,
    audit,
    layerPermissionProfilesOff,
    Layer.mock(Settings.ServerSettingsService)({ getSettings: Ref.get(settings) }),
    Layer.mock(Projects.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
    Layer.mock(Environment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.mock(Threads.ThreadManagementService)({}),
  );
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
    service: Context.get(built, Workspace.AgentWorkspaceMcpService),
  };
});

const feature = Workspace.layer.pipe(
  Layer.provide(Access.layer),
  Layer.provide(Layer.succeed(Audit.AgentWorkspaceTerminalAudit, { append: () => Effect.void })),
  Layer.provide(Layer.mock(WorkspaceEntries.WorkspaceEntries)({})),
  Layer.provide(Layer.mock(WorkspaceFiles.WorkspaceFileSystem)({})),
  Layer.provide(dependencies),
);

it.effect("#2059 refuses live workspace reads without an explicit file grant", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({
      name: "goat_call",
      arguments: {
        path: "workspace.read",
        args: { projectId: "fixture-project", path: "draft.txt" },
      },
    });
    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type === "text")
      expect(JSON.parse(content.text)).toMatchObject({
        status: "error",
        error: { code: "permission_denied", reason: "capability_denied" },
      });
  }).pipe(
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("fixture-environment"),
      capabilities: new Set(["orchestration"] as const),
      issuedAt: 0,
      requestNamespace: "fixture-client",
      grantedScopes: ["orchestration:read"],
      reauthorize: () => Effect.void,
      thread: undefined,
      client: { sessionId: "fixture-client", label: "Fixture", access: "read-only" },
    }),
    Effect.provide(
      catalog.pipe(
        Layer.provide(Layer.merge(dependencies, feature)),
        Layer.provideMerge(McpServer.McpServer.layer),
      ),
    ),
  ),
);

it.effect(
  "#2059 reads uncommitted UTF-8 pages with full-file versions and refuses revoked grants",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.writeFileString(`${f.root}/draft.txt`, "한글😀\n");
      const partial = yield* f.service.read(f.scope, {
        projectId: f.projectId,
        path: "draft.txt",
        maxBytes: 6,
      });
      expect(partial.contents).toBe("한글");
      expect(partial.nextOffset).toBe(6);
      expect(partial.version).toBeUndefined();
      const tail = yield* f.service.read(f.scope, {
        projectId: f.projectId,
        path: "draft.txt",
        offset: partial.nextOffset,
      });
      expect(tail.contents).toBe("😀\n");
      expect(tail.eof).toBe(true);
      const whole = yield* f.service.read(f.scope, {
        projectId: f.projectId,
        path: "draft.txt",
        maxBytes: 32768,
      });
      expect(whole.version).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(
        yield* f.service
          .read(f.scope, { projectId: f.projectId, path: "draft.txt", offset: 1 })
          .pipe(Effect.isFailure),
      ).toBe(true);
      yield* Ref.set(f.grants, []);
      expect(
        (yield* f.service
          .read(f.scope, { projectId: f.projectId, path: "draft.txt" })
          .pipe(Effect.flip)).code,
      ).toBe("capability_denied");
      expect(JSON.stringify(f.events)).not.toContain("한글");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("#2059 confines files and path search to the selected workspace", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.writeFileString(`${f.root}/draft.txt`, "work in progress");
    yield* f.fs.writeFileString(`${f.outside}/secret.txt`, "outside fixture");
    yield* f.fs.symlink(f.outside, `${f.root}/escape`);
    yield* f.fs.symlink(`${f.outside}/absent`, `${f.root}/dangling`);
    for (const path of [
      "../secret.txt",
      `${f.outside}/secret.txt`,
      "escape/secret.txt",
      "dangling",
      ".git/config",
      "C:/secret",
      "~/secret",
      "file\0.txt",
    ])
      expect(
        yield* f.service.read(f.scope, { projectId: f.projectId, path }).pipe(Effect.isFailure),
        path,
      ).toBe(true);
    const missing = yield* f.service.read(f.scope, { projectId: f.projectId, path: "absent" });
    expect(missing.exists).toBe(false);
    const result = yield* f.service.search(f.scope, { projectId: f.projectId, query: "txt" });
    expect(result.entries.map((entry) => entry.path)).toEqual(["draft.txt"]);
    expect(result.truncated).toBe(true);
    const first = yield* f.service.list(f.scope, { projectId: f.projectId, limit: 1 });
    expect(first.entries[0]?.path).toBe("draft.txt");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "#2059 keeps old full-access grants and sparse owner profiles from gaining file or shell authority",
  () =>
    Effect.gen(function* () {
      const owner = yield* decodeGoatclaw({});
      expect(owner.profiles.owner?.capabilities).not.toContain("workspace.write");
      expect(owner.profiles.owner?.capabilities).not.toContain("terminal.operate");
      const scopes = mcpClientScopes("full-access");
      for (const permission of [
        "filesystem:read",
        "filesystem:write",
        "terminal:read",
        "terminal:operate",
      ])
        expect(scopes).not.toContain(permission);
      expect(
        clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, {
          patch: {},
          agentTerminalBinding: { sessionId: "fixture-client", threadId: null },
        }),
      ).toEqual(["settings:write", "access:write"]);
      const settings = yield* Settings.ServerSettingsService;
      expect(
        yield* settings
          .updateSettings({ agentWorkspaceAccess: "read_write" })
          .pipe(Effect.isFailure),
      ).toBe(true);
      expect((yield* settings.getSettings).agentWorkspaceAccess).toBe("off");
    }).pipe(Effect.provide(Settings.layerTest())),
);
