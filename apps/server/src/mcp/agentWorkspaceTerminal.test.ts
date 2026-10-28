import { fixture, terminalFixture } from "./agentWorkspaceTerminal.testkit.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ServerSettings,
  GoatclawSettings,
  clientRpcRequiredScopes,
  WS_METHODS,
  AuthSessionId,
  ThreadId,
  AgentWorkspaceListInput,
  type AuthEnvironmentScope,
  ProviderInstanceId,
} from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Config from "../config.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import { McpInvocationContext } from "./McpInvocationContext.ts";
import { catalog, client, dependencies } from "./agentSurface.testkit.ts";
import * as Workspace from "./AgentWorkspaceMcpService.ts";
import * as Access from "./AgentWorkspaceTerminalAccess.ts";
import * as Audit from "./AgentWorkspaceTerminalAudit.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFiles from "../workspace/WorkspaceFileSystem.ts";
import * as Settings from "../serverSettings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { mcpClientScopes } from "../auth/mcpClientScopes.ts";
import * as TerminalService from "./AgentTerminalMcpService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as ConnectRuntime from "../auth/ConnectHubRuntime.testkit.ts";
import * as SettingsRpc from "../auth/SettingsRpc.ts";
import * as Routes from "../provider/CodexRouteService.ts";
const decodePersistedSettings = Schema.decodeUnknownEffect(ServerSettings);
const decodeGoatclaw = Schema.decodeEffect(GoatclawSettings);
const decodeListInput = Schema.decodeEffect(AgentWorkspaceListInput);

it.effect("#2059 keeps cursors reusable for long escaped directory paths", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const path = Array.from({ length: 10 }, () => '"'.repeat(240)).join("/");
    yield* f.fs.makeDirectory(`${f.root}/${path}`, { recursive: true });
    for (const name of ["a", "b"]) yield* f.fs.writeFileString(`${f.root}/${path}/${name}`, name);
    yield* Ref.set(f.listed, [
      { path: `${path}/a`, kind: "file" },
      { path: `${path}/b`, kind: "file" },
    ]);
    const first = yield* f.service.list(f.scope, { projectId: f.projectId, path, limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const nextInput = yield* decodeListInput({
      projectId: f.projectId,
      path,
      limit: 1,
      cursor: first.nextCursor!,
    });
    const next = yield* f.service.list(f.scope, nextInput);
    expect(next.entries[0]?.path).toBe(`${path}/b`);
    expect(next.nextCursor).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("#2059 preserves valid audit JSON and correlation for escaped metadata", () =>
  Effect.gen(function* () {
    const audit = yield* Audit.AgentWorkspaceTerminalAudit;
    const sql = yield* SqlClient.SqlClient;
    yield* audit.append(
      {
        environmentId: EnvironmentId.make("fixture"),
        issuedAt: 0,
        requestNamespace: "fixture",
        capabilities: new Set(),
        thread: undefined,
        client: { sessionId: "fixture", label: "Fixture", access: "read-only" },
      },
      "workspace.list",
      "\u0001".repeat(4000),
      "requested",
      "fixture-correlation",
    );
    const rows = yield* sql<{
      target: string;
    }>`SELECT target FROM audit_events WHERE action = 'workspace.list'`;
    const metadata = JSON.parse(rows[0]!.target);
    expect(metadata.correlation).toBe("fixture-correlation");
    expect(metadata.targetTruncated).toBe(true);
    expect(metadata.targetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.byteLength(rows[0]!.target)).toBeLessThan(8192);
  }).pipe(
    Effect.provide(Audit.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("#2059 never resends an expired eval terminal write on resume", () =>
  Effect.gen(function* () {
    const f = yield* terminalFixture();
    const opened = yield* f.terminal.open(f.scope);
    const process = f.pty.processes[0]!;
    process.onKill = () => process.emitExit({ exitCode: 0, signal: null });
    const context = yield* Layer.build(
      catalog.pipe(
        Layer.provide(
          Layer.mergeAll(
            dependencies,
            f.base,
            Layer.succeed(TerminalService.AgentTerminalMcpService, f.terminal),
            Layer.succeed(Workspace.AgentWorkspaceMcpService, f.service),
          ),
        ),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    );
    const server = Context.get(context, McpServer.McpServer);
    const evaluate = Effect.fn("agentWorkspaceTerminal.evaluate")(function* (
      args: Record<string, unknown>,
    ) {
      const result = yield* server.callTool({ name: "goat_eval", arguments: args });
      const content = result.content[0];
      expect(content?.type).toBe("text");
      return content?.type === "text" ? JSON.parse(content.text) : null;
    });
    yield* Effect.gen(function* () {
      const first = yield* evaluate({
        program: [
          "seq",
          ["terminal.write", { handle: opened.handle, data: "expired\\n" }],
          ["terminal.read", { handle: "invalid" }],
        ],
      });
      expect(first.status).toBe("error");
      expect(first.evalRunId).toBeDefined();
      expect(process.writes.filter((data) => data === "expired\\n")).toHaveLength(1);
      yield* TestClock.adjust("25 hours");
      const resumed = yield* evaluate({ resume: first.evalRunId });
      expect(process.writes.filter((data) => data === "expired\\n")).toHaveLength(1);
      expect(resumed.error.code).toBe("unknown_outcome");
    }).pipe(
      Effect.provideService(McpInvocationContext, f.scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
    yield* f.manager.close({ threadId: f.threadId });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("#2059 rechecks a running thread's narrowed profile mode before mutations", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const threadId = ThreadId.make("profile-caller");
    const grants: ReadonlyArray<AuthEnvironmentScope> = [
      "filesystem:read",
      "filesystem:write",
      "terminal:read",
      "terminal:operate",
    ];
    yield* Ref.set(f.grants, grants);
    yield* Ref.update(f.settings, (settings) => ({
      ...settings,
      agentTerminalAccess: "operate" as const,
      goatclaw: {
        ...settings.goatclaw,
        enabled: true,
        profiles: {
          ...settings.goatclaw.profiles,
          owner: {
            ...settings.goatclaw.profiles.owner!,
            capabilities: ["workspace.write", "terminal.operate"] as const,
            runtimeModeCeiling: "full-access" as const,
          },
        },
      },
    }));
    const profiles = Profiles.layer.pipe(
      Layer.provide(
        Layer.mock(Settings.ServerSettingsService)({ getSettings: Ref.get(f.settings) }),
      ),
      Layer.provideMerge(Sqlite.layerMemory),
    );
    const context = yield* Layer.build(
      Access.layer.pipe(Layer.provideMerge(Layer.merge(f.baseServices, profiles))),
    );
    const sql = Context.get(context, SqlClient.SqlClient);
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${threadId}, ${f.projectId}, 'Fixture', 'codex', 'full-access', 'default', '2026-01-01', '2026-01-01', '{}')`;
    const access = Context.get(context, Access.AgentWorkspaceTerminalAccess);
    const scope: McpInvocationScope = {
      ...f.scope,
      grantedScopes: grants,
      client: undefined,
      thread: {
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "fixture",
      },
    };
    yield* access.authorize(scope, {}, "terminal:operate");
    yield* Ref.update(f.settings, (settings) => ({
      ...settings,
      goatclaw: {
        ...settings.goatclaw,
        profiles: {
          ...settings.goatclaw.profiles,
          owner: { ...settings.goatclaw.profiles.owner!, runtimeModeCeiling: "auto" as const },
        },
      },
    }));
    expect((yield* access.authorize(scope, {}, "terminal:operate").pipe(Effect.flip)).code).toBe(
      "capability_denied",
    );
    yield* Ref.update(f.settings, (settings) => ({
      ...settings,
      goatclaw: {
        ...settings.goatclaw,
        profiles: {
          ...settings.goatclaw.profiles,
          owner: {
            ...settings.goatclaw.profiles.owner!,
            runtimeModeCeiling: "approval-required" as const,
          },
        },
      },
    }));
    expect((yield* access.authorize(scope, {}, "filesystem:write").pipe(Effect.flip)).code).toBe(
      "capability_denied",
    );
    yield* Ref.update(f.settings, (settings) => ({
      ...settings,
      goatclaw: { ...settings.goatclaw, enabled: false },
    }));
    yield* access.authorize(scope, {}, "terminal:operate");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("#2059 preserves a body U+FEFF at a nonzero page boundary", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.writeFileString(`${f.root}/draft.txt`, "a\ufeffb");
    const first = yield* f.service.read(f.scope, {
      projectId: f.projectId,
      path: "draft.txt",
      maxBytes: 1,
    });
    const next = yield* f.service.read(f.scope, {
      projectId: f.projectId,
      path: "draft.txt",
      offset: first.nextOffset,
      maxBytes: 4,
    });
    expect(first.contents + next.contents).toBe("a\ufeffb");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

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
      expect(clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, undefined)).toEqual([
        "settings:write",
      ]);
      const settings = yield* Settings.ServerSettingsService;
      expect(
        yield* settings
          .updateSettings({ agentWorkspaceAccess: "read_write" })
          .pipe(Effect.isFailure),
      ).toBe(true);
      expect((yield* settings.getSettings).agentWorkspaceAccess).toBe("off");
    }).pipe(Effect.provide(Settings.layerTest())),
);

it.effect("#2059 conditionally saves text and creates without clobbering", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.writeFileString(`${f.root}/draft.txt`, "\ufeffold\r\ntext\r\n");
    const loaded = yield* f.service.read(f.scope, {
      projectId: f.projectId,
      path: "draft.txt",
      maxBytes: 32768,
    });
    const saved = yield* f.service.write(f.scope, {
      projectId: f.projectId,
      path: "draft.txt",
      contents: "new\ntext\n",
      expectedVersion: loaded.version!,
    });
    expect(Buffer.from(yield* f.fs.readFile(`${f.root}/draft.txt`)).toString("utf8")).toBe(
      "\ufeffnew\r\ntext\r\n",
    );
    yield* f.fs.writeFileString(`${f.root}/draft.txt`, "external edit");
    const stale = yield* f.service
      .write(f.scope, {
        projectId: f.projectId,
        path: "draft.txt",
        contents: "lost",
        expectedVersion: saved.version,
      })
      .pipe(Effect.flip);
    expect(stale.code).toBe("conflict");
    expect(yield* f.fs.readFileString(`${f.root}/draft.txt`)).toBe("external edit");
    const created = yield* f.service.write(f.scope, {
      projectId: f.projectId,
      path: "new.txt",
      contents: "first",
      expectedVersion: null,
    });
    expect(created.version).toMatch(/^sha256:/);
    expect(
      (yield* f.service
        .write(f.scope, {
          projectId: f.projectId,
          path: "new.txt",
          contents: "second",
          expectedVersion: null,
        })
        .pipe(Effect.flip)).code,
    ).toBe("conflict");
    expect(yield* f.fs.readFileString(`${f.root}/new.txt`)).toBe("first");
    expect(
      yield* f.service
        .write(f.scope, {
          projectId: f.projectId,
          path: "large.txt",
          contents: "한".repeat(12000),
          expectedVersion: null,
        })
        .pipe(Effect.isFailure),
    ).toBe(true);
    expect(yield* f.fs.exists(`${f.root}/large.txt`)).toBe(false);
    expect(JSON.stringify(f.events)).not.toContain("external edit");
    yield* Ref.set(f.auditOnline, false);
    expect(
      yield* f.service
        .write(f.scope, {
          projectId: f.projectId,
          path: "no-audit.txt",
          contents: "not published",
          expectedVersion: null,
        })
        .pipe(Effect.isFailure),
    ).toBe(true);
    expect(yield* f.fs.exists(`${f.root}/no-audit.txt`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("#2059 rejects omitted and null mutation keys through direct tools and goat_call", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const key of [undefined, null]) {
      const args = {
        projectId: "fixture-project",
        path: "draft.txt",
        contents: "changed",
        expectedVersion: null,
        ...(key === undefined ? {} : { clientRequestId: key }),
      };
      for (const route of ["goat_workspace_write", "goat_call"]) {
        const result = yield* server.callTool({
          name: route,
          arguments: route === "goat_call" ? { path: "workspace.write", args } : args,
        });
        const content = result.content[0];
        expect(content?.type).toBe("text");
        if (content?.type === "text") {
          const body = JSON.parse(content.text);
          expect(route === "goat_call" ? body.error.code : body.code).toBe("invalid_request");
        }
      }
    }
  }).pipe(
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("fixture-environment"),
      capabilities: new Set(["orchestration"] as const),
      issuedAt: 0,
      requestNamespace: "fixture-client",
      grantedScopes: [],
      reauthorize: () => Effect.void,
      thread: undefined,
      client: { sessionId: "fixture-client", label: "Fixture", access: "full-access" },
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
  "#2059 binds PTY mutations to their opener and reads bounded output without spawning",
  () =>
    Effect.gen(function* () {
      const f = yield* terminalFixture();
      expect((yield* f.terminal.list(f.scope)).terminals).toEqual([]);
      expect(f.pty.processes).toHaveLength(0);
      const opened = yield* f.terminal.open(f.scope);
      expect(opened.owned).toBe(true);
      const process = f.pty.processes[0]!;
      process.onKill = () => process.emitExit({ exitCode: 0, signal: null });
      const emit = Effect.fn("agentWorkspaceTerminal.emit")(function* (data: string) {
        const received = yield* Deferred.make<void>();
        const stop = yield* f.manager.subscribe((event) =>
          event.type === "output" && event.data === data
            ? Deferred.succeed(received, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        process.emitData(data);
        yield* Deferred.await(received);
        stop();
      });
      yield* emit("\ud83d");
      const incomplete = yield* f.terminal.read(f.scope, { handle: opened.handle });
      expect(incomplete.data).toBe("");
      yield* emit("\ude00x");
      const first = yield* f.terminal.read(f.scope, { handle: opened.handle, maxBytes: 4 });
      expect(first.data).toBe("😀");
      const next = yield* f.terminal.read(f.scope, {
        handle: opened.handle,
        cursor: first.nextCursor,
      });
      expect(next.data).toBe("x");
      expect(next.eof).toBe(true);
      expect(f.pty.processes).toHaveLength(1);
      const other = {
        ...f.scope,
        client: { sessionId: "fixture-other", label: "Other", access: "full-access" as const },
      };
      expect(
        yield* f.terminal
          .mutate(other, { handle: opened.handle, data: "stolen\n" }, "write")
          .pipe(Effect.isFailure),
      ).toBe(true);
      const cleared = yield* f.terminal.mutate(f.scope, { handle: opened.handle }, "clear");
      expect(cleared.handle).not.toBe(opened.handle);
      expect(
        (yield* f.terminal.read(f.scope, { handle: opened.handle, cursor: next.nextCursor })).gap,
      ).toBe(true);
      expect(
        yield* f.terminal
          .mutate(f.scope, { handle: opened.handle, data: "stale\n" }, "write")
          .pipe(Effect.isFailure),
      ).toBe(true);
      yield* f.terminal.mutate(f.scope, { handle: cleared.handle, data: "owned\n" }, "write");
      expect(process.writes).toContain("owned\n");
      expect(process.writes).not.toContain("stolen\n");
      const closed = yield* f.terminal.mutate(f.scope, { handle: cleared.handle }, "close");
      expect(closed.status).toBe("closed");
      expect(process.killed).toBe(true);
      expect(JSON.stringify(f.events)).not.toContain("owned\\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("#2059 cannot adopt human PTYs or retain authority after client rebinding", () =>
  Effect.gen(function* () {
    const f = yield* terminalFixture();
    yield* f.manager.open({ threadId: f.threadId, terminalId: "human-terminal", cwd: f.root });
    f.pty.processes[0]!.onKill = () => f.pty.processes[0]!.emitExit({ exitCode: 0, signal: null });
    const human = (yield* f.terminal.list(f.scope)).terminals[0]!;
    expect(human.owned).toBe(false);
    expect(
      yield* f.terminal.mutate(f.scope, { handle: human.handle }, "close").pipe(Effect.isFailure),
    ).toBe(true);
    const opened = yield* f.terminal.open(f.scope);
    f.pty.processes[1]!.onKill = () => f.pty.processes[1]!.emitExit({ exitCode: 0, signal: null });
    yield* Ref.update(f.settings, (settings) => ({
      ...settings,
      agentTerminalClientBindings: {
        ...settings.agentTerminalClientBindings,
        [AuthSessionId.make("fixture-client")]: { threadId: f.threadId, generation: "replaced" },
      },
    }));
    expect(
      yield* f.terminal.mutate(f.scope, { handle: opened.handle }, "close").pipe(Effect.isFailure),
    ).toBe(true);
    const inherited = (yield* f.terminal.list(f.scope)).terminals;
    expect(inherited.every((terminal) => !terminal.owned)).toBe(true);
    yield* Ref.update(f.settings, (settings) => ({
      ...settings,
      agentTerminalAccess: "off" as const,
    }));
    expect(yield* f.terminal.read(f.scope, { handle: opened.handle }).pipe(Effect.isFailure)).toBe(
      true,
    );
    expect(f.pty.processes.every((process) => !process.killed)).toBe(true);
    yield* f.manager.close({ threadId: f.threadId });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "#2059 replays PTY mutations once and binds an open receipt to the current client binding",
  () =>
    Effect.gen(function* () {
      const f = yield* terminalFixture();
      const context = yield* Layer.build(
        catalog.pipe(
          Layer.provide(
            Layer.mergeAll(
              dependencies,
              f.base,
              Layer.succeed(TerminalService.AgentTerminalMcpService, f.terminal),
              Layer.succeed(Workspace.AgentWorkspaceMcpService, f.service),
            ),
          ),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      );
      const server = Context.get(context, McpServer.McpServer);
      const call = Effect.fn("agentWorkspaceTerminal.call")(function* (
        path: string,
        args: Record<string, unknown>,
      ) {
        const result = yield* server.callTool({ name: "goat_call", arguments: { path, args } });
        const content = result.content[0];
        expect(content?.type).toBe("text");
        return content?.type === "text" ? JSON.parse(content.text) : null;
      });
      const run = Effect.gen(function* () {
        const opened = yield* call("terminal.open", { clientRequestId: "open-a" });
        expect(opened.status).toBe("ok");
        const handle: string = opened.value.handle;
        expect((yield* call("terminal.open", { clientRequestId: "open-a" })).value.handle).toBe(
          handle,
        );
        expect(f.pty.processes).toHaveLength(1);
        const process = f.pty.processes[0]!;
        process.onKill = () => process.emitExit({ exitCode: 0, signal: null });
        const write = { handle, data: "once\n", clientRequestId: "write-a" };
        expect((yield* call("terminal.write", write)).status).toBe("ok");
        expect((yield* call("terminal.write", write)).status).toBe("ok");
        expect(process.writes.filter((data) => data === "once\n")).toHaveLength(1);
        const clear = { handle, clientRequestId: "clear-a" };
        const cleared = yield* call("terminal.clear", clear);
        expect(cleared.status).toBe("ok");
        expect((yield* call("terminal.clear", clear)).value.handle).toBe(cleared.value.handle);
        const close = { handle: cleared.value.handle, clientRequestId: "close-a" };
        expect((yield* call("terminal.close", close)).value.status).toBe("closed");
        expect((yield* call("terminal.close", close)).value.status).toBe("closed");
        yield* Ref.update(f.settings, (settings) => ({
          ...settings,
          agentTerminalClientBindings: {
            ...settings.agentTerminalClientBindings,
            [AuthSessionId.make("fixture-client")]: {
              threadId: f.threadId,
              generation: "new-binding",
            },
          },
        }));
        expect((yield* call("terminal.open", { clientRequestId: "open-a" })).error.reason).toBe(
          "idempotency_mismatch",
        );
        expect(f.pty.processes).toHaveLength(1);
      });
      yield* run.pipe(
        Effect.provideService(McpInvocationContext, f.scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "#2059 denies protected settings from a withdrawn Connect generation despite active scopes",
  () =>
    Effect.gen(function* () {
      const runtime = yield* ConnectRuntime.open();
      yield* runtime.settings.start;
      yield* runtime.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: true },
      });
      const session = yield* runtime.sessions
        .issue({
          subject: "cloud-connect",
          scopes: ["settings:write", "hub:proxy"],
          connectAccessGeneration: (yield* runtime.access.current).generation,
        })
        .pipe(Effect.flatMap((issued) => runtime.sessions.verify(issued.token)));
      yield* Effect.gen(function* () {
        const update = yield* SettingsRpc.make(session);
        yield* update({ patch: { agentWorkspaceAccess: "read" } });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER hold_connect_session BEFORE UPDATE ON auth_sessions WHEN OLD.subject = 'cloud-connect' BEGIN SELECT RAISE(FAIL, 'hold fixture session'); END`;
        yield* runtime.access.commitPolicy(false, Effect.void);
        expect(yield* runtime.sessions.readActiveScopes(session.sessionId)).toContain(
          "settings:write",
        );
        expect(
          yield* update({ patch: { agentWorkspaceAccess: "read_write" } }).pipe(Effect.isFailure),
        ).toBe(true);
        expect((yield* runtime.settings.getSettings).agentWorkspaceAccess).toBe("read");
      }).pipe(
        Effect.provide(Layer.mock(Routes.CodexRouteService)({})),
        Effect.provideContext(runtime.context),
      );
    }).pipe(Effect.scoped, Effect.provide(ConnectRuntime.storage)),
);

it.effect.each(["enabled", "connectDevicesHubProxy"] as const)(
  "#2059 persists a live Connect caller's own Hub opt-out (%s)",
  (key) =>
    Effect.gen(function* () {
      const runtime = yield* ConnectRuntime.open();
      yield* runtime.settings.start;
      yield* runtime.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: true },
      });
      const caller = yield* runtime.sessions
        .issue({
          subject: "cloud-connect",
          scopes: ["hub:proxy", "settings:write"],
          connectAccessGeneration: (yield* runtime.access.current).generation,
        })
        .pipe(Effect.flatMap((issued) => runtime.sessions.verify(issued.token)));
      yield* Effect.gen(function* () {
        const update = yield* SettingsRpc.make(caller);
        yield* update({ patch: { hub: { [key]: false } } });
        const fs = yield* FileSystem.FileSystem;
        const config = yield* Config.ServerConfig;
        const persisted = yield* decodePersistedSettings(
          JSON.parse(yield* fs.readFileString(config.settingsPath)),
        );
        expect(persisted.hub[key]).toBe(false);
        expect((yield* runtime.settings.getSettings).hub[key]).toBe(false);
        expect((yield* runtime.access.current).allowed).toBe(false);
      }).pipe(
        Effect.provide(Layer.mock(Routes.CodexRouteService)({})),
        Effect.provideContext(runtime.context),
      );
    }).pipe(Effect.scoped, Effect.provide(ConnectRuntime.storage)),
);
