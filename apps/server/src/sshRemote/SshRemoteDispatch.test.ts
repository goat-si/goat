import { BUILTIN_PERMISSION_PROFILES } from "@goat/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as Queue from "effect/Queue";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import {
  NodeId,
  RunId,
  EnvironmentId,
  ProviderInstanceId,
  ProjectId,
  ProjectCreatePayload,
  OrchestratorMcpFailure,
  RuntimeMode,
  ThreadId,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type DesktopSshEnvironmentTarget,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import * as SshConfig from "@goat/ssh/config";
import { SshCommandError, SshLaunchError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient } from "effect/http";
import { buildRemoteGoatRunnerScript } from "@goat/ssh/tunnel";

import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as Coordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as LaunchWatchService from "../mcp/LaunchWatchService.ts";
import Migration0062 from "../persistence/Migrations/069_RemoteReports.ts";
import Migration0063 from "../persistence/Migrations/070_RemoteDispatches.ts";
import Migration0065 from "../persistence/Migrations/072_RemoteDispatchQuestions.ts";
import Migration0068 from "../persistence/Migrations/074_RemoteReportRelay.ts";
import Migration0073 from "../persistence/Migrations/079_MemoryTaskGrantCeiling.ts";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { hostFailure } from "../mcp/hostFailure.ts";
import { fromFailure } from "@goat/contracts/agentSurface/envelope";
import {
  host,
  initialize,
  type ToolAnswer,
  withRemote,
} from "./SshRemoteDispatch.hostCall.testkit.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";
import {
  broadWorkspaceRoot,
  matchRemoteProject,
  readRemoteToolResult,
  resolveSshCliRunner,
} from "./SshRemoteDispatch.ts";
import { layerPermissionProfilesOff } from "../mcp/McpToolAccess.testkit.ts";

describe("SSH dispatch tool compatibility", () => {
  it.effect("fails once with the host and unknown GOAT tool on a legacy-only endpoint", () =>
    Effect.gen(function* () {
      const host = "legacy-host";
      const target = { alias: host, hostname: host, username: null, port: null };
      // Build the legacy catalog explicitly without adding live old-name fixtures to the gate.
      const legacyTools = new Set(
        ["project_list", "project_create", "thread_launch"].map((suffix) => `t3_${suffix}`),
      );
      const calls: string[] = [];
      let projectsCreated = 0;
      let threadsLaunched = 0;
      const fetchEndpoint = vi.fn(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          id?: string;
          method: string;
          params?: { name?: string };
        };
        switch (request.method) {
          case "initialize":
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "T3 Code", version: "legacy" },
              },
            });
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: { tools: [...legacyTools].map((name) => ({ name })) },
            });
          case "tools/call": {
            const name = request.params?.name ?? "";
            calls.push(name);
            if (!legacyTools.has(name)) {
              return Response.json({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32602, message: `Unknown tool: ${name}; legacy catalog only` },
              });
            }
            if (name.endsWith("project_create")) projectsCreated += 1;
            if (name.endsWith("thread_launch")) threadsLaunched += 1;
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                structuredContent: { projects: [], id: "new-project", threadId: "new-thread" },
              },
            });
          }
          default:
            throw new Error(`Unexpected remote method: ${request.method}`);
        }
      });
      const manager = SshTunnel.SshEnvironmentManager.of({
        status: () => Effect.die("Unexpected runtime status"),
        ensureEnvironment: () =>
          Effect.succeed({
            target,
            httpBaseUrl: "http://legacy-host:3773/",
            wsBaseUrl: "ws://legacy-host:3773/",
            pairingToken: null,
          }),
        readyEnvironment: () => Effect.die("Unexpected ready environment"),
        beginSetupOperation: () => Effect.die("Unexpected setup operation"),
        publishSetupOutcome: () => Effect.succeed(true),
        publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
        forgetEnvironment: () => Effect.die("Unexpected forget"),
        disconnectEnvironment: () => Effect.die("Unexpected SSH disconnect"),
        revalidateTunnels: () => Effect.void,
        issueClientSession: () => Effect.die("unused"),
        issueMcpClientSession: () =>
          Effect.succeed({
            token: "fixture-session",
            expiresAt: null,
            runtimeModeCeilingApplied: true,
          }),
        runRemoteScript: () =>
          Effect.succeed({
            stdout:
              "T3B\t1\nHOME\t/home/agent\nOS\tLinux\nPATH\t/home/agent/repo\nREAL\t/home/agent/repo\n",
            stderr: "",
          }),
      });
      const discoverHosts = vi
        .spyOn(SshConfig, "discoverSshHosts")
        .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
      const managerLayer = vi
        .spyOn(SshTunnel.SshEnvironmentManager, "layer")
        .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
      vi.stubGlobal("fetch", fetchEndpoint);
      try {
        const result = yield* Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch
            .launchThread(
              {
                host,
                cwd: "/home/agent/repo",
                workspace: { type: "cwd" },
                title: "Compatibility probe",
                runtimeMode: "approval-required",
                callerRuntimeMode: "approval-required",
              },
              Effect.void,
            )
            .pipe(Effect.result);
        }).pipe(
          Effect.provide(
            SshRemoteDispatch.layer.pipe(
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-dispatch-test-" })),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") throw new Error("Expected remote dispatch failure");
        expect(result.failure.reason).toBe("ssh_failed");
        expect(result.failure.message).toContain("Calling goat_project_list on legacy-host failed");
        expect(result.failure.message).toContain(
          "Unknown tool: goat_project_list; legacy catalog only",
        );
        expect(calls).toEqual(["goat_project_list"]);
        expect(projectsCreated).toBe(0);
        expect(threadsLaunched).toBe(0);
        expect(fetchEndpoint).toHaveBeenCalledTimes(3);
      } finally {
        vi.unstubAllGlobals();
        managerLayer.mockRestore();
        discoverHosts.mockRestore();
      }
    }),
  );
});

describe("broadWorkspaceRoot", () => {
  const folder = (path: string, home: string | null = "/Users/jun", realPath = path) => ({
    path,
    realPath,
    home,
  });

  it("refuses the root, home, folders above home, and other top-level folders", () => {
    expect(broadWorkspaceRoot(folder("/"))).toBe("the filesystem root");
    expect(broadWorkspaceRoot(folder("/Users/jun/"))).toBe("the home directory");
    expect(broadWorkspaceRoot(folder("/users/JUN"))).toBe("the home directory");
    expect(broadWorkspaceRoot(folder("/Users"))).toBe("a folder that contains the home directory");
    expect(broadWorkspaceRoot(folder("/tmp"))).toBe("a top-level folder");
    expect(broadWorkspaceRoot(folder("/srv", null))).toBe("a top-level folder");
    expect(broadWorkspaceRoot(folder("C:\\", "C:\\Users\\jun"))).toBe("the filesystem root");
    expect(broadWorkspaceRoot(folder("C:\\Users\\jun", "C:\\Users\\jun"))).toBe(
      "the home directory",
    );
  });

  it("refuses a link whose physical path is the home directory", () => {
    expect(broadWorkspaceRoot(folder("/work/me", "/home/me", "/home/me"))).toBe(
      "the home directory",
    );
  });

  it("accepts a project folder below home or elsewhere", () => {
    expect(broadWorkspaceRoot(folder("/Users/jun/Developer/goat"))).toBeNull();
    expect(broadWorkspaceRoot(folder("/Users/jun/scratch"))).toBeNull();
    expect(broadWorkspaceRoot(folder("/srv/app", null))).toBeNull();
    expect(broadWorkspaceRoot(folder("/home/agent/repo", "/home/agent"))).toBeNull();
  });
});

describe("matchRemoteProject", () => {
  const project = { id: "project-1", workspaceRoot: "/home/agent/repo/" };

  it("matches paths with different trailing slash counts", () => {
    expect(
      matchRemoteProject([project], {
        path: "/home/agent/repo///",
        realPath: "/elsewhere",
        os: "Linux",
      }),
    ).toBe(project);
  });

  it("matches the physical path of a browsed symlink", () => {
    expect(
      matchRemoteProject([project], {
        path: "/home/agent/repo-link",
        realPath: "/home/agent/repo",
        os: "Linux",
      }),
    ).toBe(project);
  });

  it("matches different casing on Darwin", () => {
    expect(
      matchRemoteProject([project], {
        path: "/HOME/AGENT/REPO",
        realPath: "/elsewhere",
        os: "Darwin",
      }),
    ).toBe(project);
  });

  it("also folds the physical path on Darwin", () => {
    expect(
      matchRemoteProject([project], {
        path: "/alias",
        realPath: "/HOME/AGENT/REPO/",
        os: "Darwin",
      }),
    ).toBe(project);
  });

  it.each([
    "C:\\Users\\super\\Developer\\goat",
    "c:\\users\\super\\developer\\goat\\",
    "C:/Users/super/Developer/goat",
    "/c/Users/super/Developer/goat",
  ])("matches a linked Windows host's project by Windows rules: %s", (cwd) => {
    // A linked host reports no OS; its native project roots show it is Windows.
    const windows = { id: "windows", workspaceRoot: "C:\\Users\\super\\Developer\\goat" };
    expect(matchRemoteProject([project, windows], { path: cwd, realPath: cwd, os: null })).toBe(
      windows,
    );
  });

  it("never folds a POSIX project root on a host without an OS", () => {
    const posix = { id: "posix", workspaceRoot: "/c/Users/super/goat" };
    expect(
      matchRemoteProject([posix], {
        path: "C:/Users/super/goat",
        realPath: "C:/Users/super/goat",
        os: null,
      }),
    ).toBeUndefined();
  });

  it.each(["Linux", "Windows_NT", "darwin", null])("keeps case-sensitive matching on %s", (os) => {
    expect(
      matchRemoteProject([project], {
        path: "/HOME/AGENT/REPO",
        realPath: "/HOME/AGENT/REPO",
        os,
      }),
    ).toBeUndefined();
  });

  it("prefers an exact match over an earlier case-folded match on Darwin", () => {
    const folded = { id: "folded", workspaceRoot: "/HOME/AGENT/REPO" };
    expect(
      matchRemoteProject([folded, project], {
        path: "/home/agent/repo",
        realPath: "/home/agent/repo",
        os: "Darwin",
      }),
    ).toBe(project);
  });

  it("does not confuse a child folder or path prefix with the registered project", () => {
    expect(
      matchRemoteProject([project], {
        path: "/home/agent/repo/sub",
        realPath: "/home/agent/repo-other",
        os: "Linux",
      }),
    ).toBeUndefined();
  });

  it("preserves the root path and handles an empty project list", () => {
    const root = { id: "root", workspaceRoot: "/" };
    const folder = { path: "/", realPath: "/", os: "Linux" };
    expect(matchRemoteProject([root], folder)).toBe(root);
    expect(matchRemoteProject([], folder)).toBeUndefined();
  });

  it.each([
    "C:\\Users\\super\\Developer\\goat",
    "c:\\users\\SUPER\\developer\\goat\\",
    "C:/Users/super/Developer/goat",
    "/c/Users/super/Developer/goat/",
    "/cygdrive/c/Users/super/Developer/goat",
  ])("matches %s on a Git Bash host by either shell form, slash, and case", (workspaceRoot) => {
    const windows = { id: "windows", workspaceRoot };
    expect(
      matchRemoteProject([windows], {
        path: "C:\\Users\\super\\Developer\\goat",
        realPath: "C:\\Users\\super\\Developer\\goat",
        os: "MINGW64_NT-10.0-26200",
      }),
    ).toBe(windows);
  });

  it("keeps drives and sibling folders apart on a Git Bash host", () => {
    const folder = {
      path: "C:\\Users\\super\\Developer\\goat",
      realPath: "C:\\Users\\super\\Developer\\goat",
      os: "CYGWIN_NT-10.0",
    };
    expect(
      matchRemoteProject(
        [
          { id: "d", workspaceRoot: "D:\\Users\\super\\Developer\\goat" },
          { id: "sibling", workspaceRoot: "C:\\Users\\super\\Developer\\goat-other" },
        ],
        folder,
      ),
    ).toBeUndefined();
  });
});

describe("readRemoteToolResult", () => {
  it("returns structured content ahead of a conflicting text payload", () => {
    const payload = { projects: [{ id: "project-1" }] };
    expect(
      readRemoteToolResult("projects_list", {
        structuredContent: payload,
        content: [{ type: "text", text: '{"projects":[]}' }],
      }),
    ).toEqual({ ok: true, value: payload });
  });

  it("decodes pretty JSON text when structured content is absent", () => {
    const payload = { threadId: "thread-1", created: true };
    expect(
      readRemoteToolResult("thread_create", {
        content: [{ type: "image" }, { type: "text", text: JSON.stringify(payload, null, 2) }],
      }),
    ).toEqual({ ok: true, value: payload });
  });

  it("preserves an explicit null structured payload", () => {
    expect(
      readRemoteToolResult("tool", {
        structuredContent: null,
        content: [{ type: "text", text: '{"fallback":true}' }],
      }),
    ).toEqual({ ok: true, value: null });
  });

  it("reports a refusal message from structured content", () => {
    expect(
      readRemoteToolResult("thread_create", {
        isError: true,
        structuredContent: { message: "permission denied" },
        content: [{ type: "text", text: "less specific" }],
      }),
    ).toEqual({ ok: false, message: "The remote thread_create refused: permission denied" });
  });

  it("reports a refusal message from JSON text", () => {
    expect(
      readRemoteToolResult("projects_list", {
        isError: true,
        content: [{ type: "text", text: '{"message":"session expired"}' }],
      }),
    ).toEqual({ ok: false, message: "The remote projects_list refused: session expired" });
  });

  it("keeps a non-JSON refusal's text", () => {
    expect(
      readRemoteToolResult("thread_create", {
        isError: true,
        content: [{ type: "text", text: "operation scope required" }],
      }),
    ).toEqual({ ok: false, message: "The remote thread_create refused: operation scope required" });
  });

  it("gives a useful refusal when the remote returns no details", () => {
    expect(readRemoteToolResult("tool", { isError: true })).toEqual({
      ok: false,
      message: "The remote tool refused: no details",
    });
  });
});

describe("SSH dispatch release mirror", () => {
  it.effect("server runner downloads from the configured mirror", () =>
    Effect.gen(function* () {
      const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            GOAT_RELEASE_BASE_URL: "  https://mirror.example/goat/  ",
          }),
        ),
      );
      const script = buildRemoteGoatRunnerScript(runner);
      expect(script).toContain("GOAT_RELEASE_BASE_URL='https://mirror.example/goat'");
      expect(script).not.toContain("github.com/goat-si/goat-releases/releases/download");
      expect(runner.archiveDirectory).toBe("/fixture/home/runtime/archives");
      expect(runner.refreshOwnedRuntimeOnFirstConnection).toBe(true);
    }),
  );

  it.effect.each([undefined, "", "  "])(
    "empty mirror %s keeps the authenticated default",
    (value) =>
      Effect.gen(function* () {
        const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord(
              { GOAT_RELEASE_BASE_URL: value },
              { preserveEmptyStrings: true },
            ),
          ),
        );
        expect("releaseBaseUrl" in runner).toBe(false);
        expect(buildRemoteGoatRunnerScript(runner)).toContain(
          "GOAT_RELEASE_BASE_URL='https://github.com/goat-si/goat-releases/releases/download'",
        );
        // The library's blank-mirror behavior test separately proves gh acquisition,
        // since running the generated shell directly is outside the guarded path.
      }),
  );
});

describe("SSH dispatch packaged runtime", () => {
  it.effect("resolves bundle separately from writable user cache", () =>
    Effect.gen(function* () {
      const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({
            GOAT_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR:
              "  /Applications/GOAT.app/Contents/Resources/ssh-runtime/archives  ",
            GOAT_SSH_RUNTIME_ARCHIVE_DIR: "/fixture/user-cache",
          }),
        ),
      );
      expect(runner.bundledArchiveDirectory).toBe(
        "/Applications/GOAT.app/Contents/Resources/ssh-runtime/archives",
      );
      expect(runner.archiveDirectory).toBe("/fixture/user-cache");
      expect(runner.refreshOwnedRuntimeOnFirstConnection).toBe(true);
    }),
  );
  it.effect.each([undefined, "", "  "])("omits empty bundle %s", (value) =>
    Effect.gen(function* () {
      const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(
            {
              GOAT_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR: value,
            },
            { preserveEmptyStrings: true },
          ),
        ),
      );
      expect("bundledArchiveDirectory" in runner).toBe(false);
      expect(runner.archiveDirectory).toBe("/fixture/home/runtime/archives");
    }),
  );
});

describe("SshRemoteDispatch.callHostTool", () => {
  const readCall = (authorize: Effect.Effect<RuntimeMode> = Effect.succeed("full-access")) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const value = yield* dispatch.callHostTool(
        {
          host,
          tool: "goat_thread_read",
          arguments: { threadId: "thread-1" },
          timeoutMs: 5_000,
          writes: false,
        },
        authorize,
      );
      return { value, connected: yield* dispatch.connectedHosts };
    });

  it.effect("fails instead of issuing a narrower session when approvals cannot be granted", () =>
    Effect.gen(function* () {
      const approvalCall = Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        return yield* dispatch.callHostTool(
          {
            host,
            tool: "goat_pending_request_respond",
            arguments: { threadId: "thread-1" },
            timeoutMs: 5_000,
            writes: true,
            approvals: true,
          },
          Effect.succeed("full-access" as const),
        );
      });
      const { result, record } = yield* withRemote(
        { answer: (request) => initialize(request) ?? { result: {} }, approvalsFail: true },
        approvalCall,
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "remote_refused",
          message: expect.stringContaining("may answer approvals"),
        },
      });
      expect(record.sessionRequests).toEqual([true]);
      expect(record.sessionsIssued).toBe(0);
      expect(record.toolCalls).toEqual([]);
    }),
  );

  it.effect("returns the remote result and remembers the host as connected", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withRemote(
        {
          answer: (request) =>
            initialize(request) ?? { result: { structuredContent: { threadId: "thread-1" } } },
        },
        readCall(),
      );
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(result.success.value).toEqual({ threadId: "thread-1" });
      expect(result.success.connected).toEqual([host]);
      expect(record.toolCalls).toEqual(["goat_thread_read"]);
    }),
  );

  it.effect("reports a tunnel that cannot be opened as host_unavailable", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withRemote(
        { ensureFails: true, answer: () => ({ result: null }) },
        readCall(),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("host_unavailable");
      expect(record.requests).toBe(0);
    }),
  );

  it.effect("reports a remote server that does not answer HTTP as host_unavailable", () =>
    Effect.gen(function* () {
      const { result } = yield* withRemote(
        { answer: () => ({ throws: "fetch failed" }) },
        readCall(),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("host_unavailable");
    }),
  );

  it.effect("keeps the remote's own failure code, distinct from an unreachable host", () =>
    Effect.gen(function* () {
      const { result } = yield* withRemote(
        {
          answer: (request) =>
            initialize(request) ?? {
              result: {
                isError: true,
                structuredContent: {
                  _tag: "OrchestratorMcpFailure",
                  code: "thread_not_found",
                  message: "The thread was not found.",
                },
              },
            },
        },
        readCall(),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure.reason).toBe("remote_refused");
      expect(result.failure.remoteCode).toBe("thread_not_found");
      expect(hostFailure(result.failure).code).toBe("thread_not_found");
    }),
  );

  it.effect("treats a JSON-RPC refusal as a refusal, not an unreachable host", () =>
    Effect.gen(function* () {
      const { result } = yield* withRemote(
        { answer: (request) => initialize(request) ?? { rpcError: "Unknown tool" } },
        readCall(),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("remote_refused");
    }),
  );

  it.effect.each([
    ["0.1.2", "task_status"],
    ["0.1.3", "goat_task_read"],
  ] as const)(
    "forwards a call to a remote at %s under the name it answers to: %s",
    ([version, sent]) =>
      Effect.gen(function* () {
        const call = Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.callHostTool(
            {
              host,
              tool: "goat_task_read",
              arguments: { taskId: "t" },
              timeoutMs: 5_000,
              writes: false,
            },
            Effect.succeed("full-access" as const),
          );
        });
        const { result, record } = yield* withRemote(
          {
            serverVersion: version,
            answer: (request) =>
              initialize(request) ?? { result: { structuredContent: { ok: true } } },
          },
          call,
        );
        expect(result._tag).toBe("Success");
        expect(record.toolCalls).toEqual([sent]);
      }),
  );

  it.effect("answers remote_outdated when the remote lacks the tool, and runs nothing here", () =>
    Effect.gen(function* () {
      const call = Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        return yield* dispatch.callHostTool(
          { host, tool: "goat_provider_sync_read", arguments: {}, timeoutMs: 5_000, writes: false },
          Effect.succeed("full-access" as const),
        );
      });
      const { result, record } = yield* withRemote(
        {
          answer: (request) =>
            initialize(request) ?? { rpcError: "Tool 'goat_provider_sync_status' not found" },
        },
        call,
      );
      expect(record.toolCalls).toEqual(["goat_provider_sync_status"]);
      if (result._tag !== "Failure") throw new Error("expected a refusal");
      expect(result.failure.reason).toBe("remote_outdated");
      expect(hostFailure(result.failure)).toMatchObject({
        code: "remote_outdated",
        reason: "remote_outdated",
      });
      expect(fromFailure({ ...hostFailure(result.failure) }, { effect: "read" })).toMatchObject({
        status: "error",
        error: { code: "failed_precondition", reason: "remote_outdated", retryable: false },
      });
    }),
  );

  it.effect("names an older remote that lacks the tool, in the form status fallback matches", () =>
    Effect.gen(function* () {
      const statusCall = Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        return yield* dispatch.callHostTool(
          {
            host,
            tool: "goat_thread_status",
            arguments: { threadId: "thread-1" },
            timeoutMs: 5_000,
            writes: false,
          },
          Effect.succeed("full-access" as const),
        );
      });
      const { result } = yield* withRemote(
        {
          answer: (request) =>
            initialize(request) ?? { rpcError: "Tool 'goat_thread_status' not found" },
        },
        statusCall,
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "remote_outdated",
          message: expect.stringContaining(
            `GOAT on ${host} ${SshRemoteDispatch.REMOTE_THREAD_STATUS_UNSUPPORTED}; it runs an older build`,
          ),
        },
      });
    }),
  );

  it.effect("shares one in-flight session issuance for concurrent calls with the same key", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { result, record } = yield* withRemote(
        {
          beforeSessionIssue: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          answer: (request) =>
            initialize(request) ?? {
              result: { structuredContent: { authorization: request.authorization } },
            },
        },
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(readCall(), { startImmediately: true });
          yield* Deferred.await(started);
          // Run the second caller up to its lock wait before releasing the issuer.
          const second = yield* Effect.forkChild(readCall(), { startImmediately: true });
          yield* Deferred.succeed(release, undefined);
          return [yield* Fiber.join(first), yield* Fiber.join(second)];
        }),
      );
      expect(result).toMatchObject({
        _tag: "Success",
        success: [
          { value: { authorization: "Bearer session-1" } },
          { value: { authorization: "Bearer session-1" } },
        ],
      });
      expect(record.sessionRequests).toEqual([false]);
      expect(record.sessionsIssued).toBe(1);
    }),
  );

  it.effect.each(["runtime ceiling", "approvals"] as const)(
    "issues independently for concurrent calls with different %s keys",
    (differentKey) =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { result, record } = yield* withRemote(
          {
            beforeSessionIssue: (attempt) =>
              Deferred.succeed(attempt === 1 ? firstStarted : secondStarted, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              ),
            answer: (request) => initialize(request) ?? { result: { structuredContent: {} } },
          },
          Effect.gen(function* () {
            const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
            const first = yield* Effect.forkChild(readCall(), { startImmediately: true });
            yield* Deferred.await(firstStarted);
            const second = yield* Effect.forkChild(
              dispatch.callHostTool(
                {
                  host,
                  tool: "goat_thread_read",
                  arguments: { threadId: "thread-2" },
                  timeoutMs: 5_000,
                  writes: false,
                  approvals: differentKey === "approvals",
                },
                Effect.succeed(
                  differentKey === "runtime ceiling" ? "approval-required" : "full-access",
                ),
              ),
              { startImmediately: true },
            );
            yield* Deferred.await(secondStarted);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(first);
            yield* Fiber.join(second);
          }),
        );
        expect(result._tag).toBe("Success");
        expect(record.sessionsIssued).toBe(2);
        expect(record.sessionRequests).toEqual([false, differentKey === "approvals"]);
      }),
  );

  it.effect("issues a providers:manage session separately from a plain session", () =>
    Effect.gen(function* () {
      const managed = Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        return yield* dispatch.callHostTool(
          {
            host,
            tool: "goat_provider_sync",
            arguments: { driver: "opencode" },
            timeoutMs: 5_000,
            writes: true,
            providersManage: true,
          },
          Effect.succeed("full-access"),
        );
      });
      const { result, record } = yield* withRemote(
        {
          answer: (request) =>
            initialize(request) ?? { result: { structuredContent: { ok: true } } },
        },
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          const first = yield* managed;
          const plain = yield* dispatch.callHostTool(
            {
              host,
              tool: "goat_thread_read",
              arguments: { threadId: "thread-1" },
              timeoutMs: 5_000,
              writes: false,
            },
            Effect.succeed("full-access"),
          );
          const again = yield* managed;
          return { first, plain, again };
        }),
      );
      expect(result._tag).toBe("Success");
      expect(record.providersManageRequests).toEqual([true, false]);
      expect(record.sessionRequests).toEqual([false, false]);
      expect(record.sessionsIssued).toBe(2);
    }),
  );

  it.effect("retries session issuance after a failed in-flight attempt", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { result, record } = yield* withRemote(
        {
          beforeSessionIssue: (attempt) =>
            attempt === 1
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.fail(
                      new SshCommandError({
                        message: "fixture issuance failed",
                        command: ["ssh", host],
                        exitCode: 255,
                        stderr: "",
                      }),
                    ),
                  ),
                )
              : Effect.void,
          answer: (request) => initialize(request) ?? { result: { structuredContent: {} } },
        },
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(readCall().pipe(Effect.result));
          yield* Deferred.await(started);
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(first))._tag).toBe("Failure");
          yield* readCall();
          yield* readCall();
        }),
      );
      expect(result._tag).toBe("Success");
      expect(record.sessionRequests).toEqual([false, false]);
      expect(record.sessionsIssued).toBe(1);
    }),
  );

  it.effect("shares one refresh when concurrent calls enter the ten-minute expiry margin", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { result, record } = yield* withRemote(
        {
          beforeSessionIssue: (attempt) =>
            attempt === 1
              ? Effect.void
              : Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          answer: (request) => initialize(request) ?? { result: { structuredContent: {} } },
        },
        Effect.gen(function* () {
          yield* readCall();
          yield* TestClock.adjust((11 * 60 + 49) * 60 * 1000);
          yield* readCall();
          yield* TestClock.adjust("1 minute");
          const first = yield* Effect.forkChild(readCall(), { startImmediately: true });
          yield* Deferred.await(started);
          const second = yield* Effect.forkChild(readCall(), { startImmediately: true });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        }),
      );
      expect(result._tag).toBe("Success");
      expect(record.sessionsIssued).toBe(2);
      expect(record.sessionRequests).toEqual([false, false]);
    }),
  );

  it.effect("reuses the fresh session after a delayed concurrent 401 for the old bearer", () =>
    Effect.gen(function* () {
      const firstRejected = yield* Deferred.make<(answer: ToolAnswer) => void>();
      const secondRejected = yield* Deferred.make<(answer: ToolAnswer) => void>();
      const refreshStarted = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      let rejected = 0;
      const { result, record } = yield* withRemote(
        {
          beforeSessionIssue: (attempt) =>
            attempt === 1
              ? Effect.void
              : Deferred.succeed(refreshStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseRefresh)),
                ),
          answer: (request) => {
            if (request.method === "initialize" && request.authorization === "Bearer session-1") {
              rejected += 1;
              const pending = rejected === 1 ? firstRejected : secondRejected;
              return new Promise<ToolAnswer>((resolve) => {
                Deferred.doneUnsafe(pending, Effect.succeed(resolve));
              });
            }
            return (
              initialize(request) ?? {
                result: { structuredContent: { authorization: request.authorization } },
              }
            );
          },
        },
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(readCall());
          const rejectFirst = yield* Deferred.await(firstRejected);
          const second = yield* Effect.forkChild(readCall());
          const rejectSecond = yield* Deferred.await(secondRejected);
          rejectFirst({ status: 401 });
          yield* Deferred.await(refreshStarted);
          yield* Deferred.succeed(releaseRefresh, undefined);
          const firstResult = yield* Fiber.join(first);
          // The old request arrives after the replacement has already been cached.
          rejectSecond({ status: 401 });
          return [firstResult, yield* Fiber.join(second)];
        }),
      );
      expect(result).toMatchObject({
        _tag: "Success",
        success: [
          { value: { authorization: "Bearer session-2" } },
          { value: { authorization: "Bearer session-2" } },
        ],
      });
      expect(record.sessionsIssued).toBe(2);
      expect(record.sessionRequests).toEqual([false, false]);
    }),
  );

  it.effect("signs in anew once when the remote rejects the cached session", () =>
    Effect.gen(function* () {
      let rejected = false;
      const { result, record } = yield* withRemote(
        {
          answer: (request) => {
            if (!rejected) {
              rejected = true;
              return { status: 401 };
            }
            return initialize(request) ?? { result: { structuredContent: { ok: true } } };
          },
        },
        readCall(),
      );
      expect(result._tag).toBe("Success");
      expect(record.sessionsIssued).toBe(2);
    }),
  );

  it.effect.each(
    [
      "goat_thread_checkpoint_capture",
      "goat_thread_checkpoint_restore",
      "goat_thread_checkpoint_reconcile",
      "goat_thread_interrupt",
    ].flatMap((tool) =>
      ["missing", "expired", "revoked", "plan", "ceiling"].map((condition) => ({
        tool,
        condition,
      })),
    ),
  )(
    "305 strict $tool refuses $condition without session creation or renewal",
    ({ tool, condition }) =>
      Effect.gen(function* () {
        let strict = false;
        let plan = false;
        const { result, record } = yield* withRemote(
          {
            ceilingApplied: condition !== "ceiling",
            answer: (request) => {
              if (strict && condition === "revoked") return { status: 401 };
              if (strict && condition === "plan" && request.method === "initialize") plan = true;
              return initialize(request) ?? { result: { structuredContent: {} } };
            },
          },
          Effect.gen(function* () {
            if (condition !== "missing") yield* readCall();
            if (condition === "expired") yield* TestClock.adjust("13 hours");
            strict = true;
            const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
            const call = {
              host,
              tool,
              arguments: { threadId: "owned-source", runId: "captured-run" },
              timeoutMs: 5_000,
              writes: true,
              requireReady: true as const,
              existingSessionOnly: true as const,
            };
            const authorize = Effect.suspend(() =>
              plan
                ? Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "capability_denied",
                      message: "Caller is now in plan mode.",
                    }),
                  )
                : Effect.succeed("full-access" as const),
            );
            const refused = yield* dispatch.callHostTool(call, authorize).pipe(Effect.result);
            expect(refused._tag).toBe("Failure");
            if (condition === "revoked") {
              const replay = yield* dispatch.callHostTool(call, authorize).pipe(Effect.result);
              expect(replay).toMatchObject({
                _tag: "Failure",
                failure: { reason: "host_unavailable" },
              });
            }
          }),
        );
        expect(result._tag).toBe("Success");
        expect(record.sessionsIssued).toBe(condition === "missing" ? 0 : 1);
        expect(record.toolCalls.filter((called) => called === tool)).toEqual([]);
      }),
  );

  it.effect("strict tools refuse HTTP 401 without retrying or minting a session", () =>
    Effect.gen(function* () {
      let reject = false;
      let rejections = 0;
      const { result, record } = yield* withRemote(
        {
          answer: (request) => {
            if (reject) {
              rejections += 1;
              return { status: 401 };
            }
            return initialize(request) ?? { result: { structuredContent: {} } };
          },
        },
        Effect.gen(function* () {
          yield* readCall();
          reject = true;
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          const call = {
            host,
            tool: "goat_thread_read",
            arguments: { threadId: "thread-1" },
            timeoutMs: 5_000,
            writes: false,
            existingSessionOnly: true as const,
          };
          const refused = yield* dispatch
            .callHostTool(call, Effect.succeed("full-access"))
            .pipe(Effect.result);
          expect(refused).toMatchObject({
            _tag: "Failure",
            failure: {
              reason: "remote_refused",
              message: expect.stringContaining("reconnect explicitly"),
            },
          });
          // A caller-level retry also remains strict after invalidation.
          const retried = yield* dispatch
            .callHostTool(call, Effect.succeed("full-access"))
            .pipe(Effect.result);
          expect(retried).toMatchObject({
            _tag: "Failure",
            failure: { reason: "host_unavailable" },
          });
        }),
      );
      expect(result._tag).toBe("Success");
      expect(rejections).toBe(1);
      expect(record.sessionsIssued).toBe(1);
      expect(record.toolCalls).toEqual(["goat_thread_read"]);
    }),
  );

  it.effect("sends nothing when the caller's runtime mode drops during the handshake", () =>
    Effect.gen(function* () {
      let checks = 0;
      const authorize = Effect.sync((): RuntimeMode => {
        checks += 1;
        return checks === 1 ? "full-access" : "approval-required";
      });
      const { result, record } = yield* withRemote(
        { answer: (request) => initialize(request) ?? { result: { structuredContent: {} } } },
        readCall(authorize),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("caller_changed");
      expect(record.toolCalls).toEqual([]);
      expect(result._tag === "Failure" && hostFailure(result.failure).code).toBe(
        "runtime_mode_escalation_denied",
      );
    }),
  );

  it.effect("refuses writes on a remote that cannot apply the caller's ceiling", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withRemote(
        { ceilingApplied: false, answer: () => ({ result: null }) },
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.callHostTool(
            {
              host,
              tool: "goat_thread_send",
              arguments: { threadId: "thread-1", message: "status?" },
              timeoutMs: 5_000,
              writes: true,
            },
            Effect.succeed("full-access"),
          );
        }),
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe("remote_refused");
      expect(record.requests).toBe(0);
    }),
  );
});

// Exercise the real project-create authorization declaration at the fake remote HTTP boundary.
const RegistrationToolkit = Toolkit.make(
  Tool.make("goat_project_create", {
    parameters: ProjectCreatePayload,
    success: Schema.Struct({ id: ProjectId }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  }),
);
const registrationLayer = McpHttpServer.toolkitRegistration(
  RegistrationToolkit,
  McpToolAccess.toLayer(RegistrationToolkit, {
    goat_project_create: McpToolAccess.writesEnvironment(() =>
      Effect.succeed({ id: ProjectId.make("rp") }),
    ),
  }),
).pipe(
  Layer.provide(layerPermissionProfilesOff),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
);
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const checkRegistration = (args: Record<string, unknown>, ceiling: RuntimeMode) =>
  Effect.scoped(
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name: "goat_project_create", arguments: args })),
      Effect.provide(registrationLayer),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("remote"),
        requestNamespace: "client:session",
        thread: undefined,
        client: { sessionId: "session", label: "GOAT", access: ceiling },
        capabilities: new Set(["orchestration"] as const),
        issuedAt: 0,
      }),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
    ),
  );
const capabilityFixture = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: [
    {
      providerInstanceId: "codex",
      driverKind: "codex",
      displayName: null,
      models: [{ id: "model", label: null }],
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 10,
  },
};
const savedTarget = { alias: "unlisted", hostname: "host.test", username: "runner", port: 2222 };
const launchInput: SshRemoteDispatch.SshLaunchInput = {
  target: savedTarget,
  cwd: "/home/agent/.goat/repos/repo-12345678",
  workspace: {
    type: "worktree",
    baseRef: "refs/heads/goat/ssh-base/12345678",
    branch: "goat/ssh/12345678",
  },
  title: "Work",
  message: "Implement",
  runtimeMode: "approval-required",
  callerRuntimeMode: "full-access",
  interactionMode: "default",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
};
const withLaunchRemote = <A, E>(
  options: {
    existing?: boolean;
    discoverSavedHost?: boolean;
    beforeReady?: Effect.Effect<void>;
    rejectSession?: () => boolean;
    ceilingApplied?: boolean;
    identity?: unknown;
    capabilities?: unknown;
    launchReply?: unknown;
    transportFailure?: boolean;
    refusal?: boolean;
    projectReply?: unknown;
    broad?: boolean;
    /** What the browse script prints, in place of a Linux listing of launchInput.cwd. */
    browseStdout?: string;
    projects?: ReadonlyArray<{ id: string; workspaceRoot: string }>;
    registrationAccess?: boolean;
    declaresMemoryCeiling?: boolean;
    beforeSessionIssue?: (scopes: ReadonlyArray<string>) => Effect.Effect<void, SshCommandError>;
  },
  body: (record: {
    tools: { name: string; args: Record<string, unknown>; authorization: string | null }[];
    targets: DesktopSshEnvironmentTarget[];
    ensures: number;
    readies: number;
    sessionRequests: Array<{
      ceiling: RuntimeMode;
      memoryScopes: ReadonlyArray<string>;
      requireReady: boolean;
    }>;
    sessions: { target: DesktopSshEnvironmentTarget; ceiling: RuntimeMode }[];
  }) => Effect.Effect<A, E, SshRemoteDispatch.SshRemoteDispatch>,
) =>
  Effect.gen(function* () {
    const record = {
      tools: [] as { name: string; args: Record<string, unknown>; authorization: string | null }[],
      targets: [] as DesktopSshEnvironmentTarget[],
      ensures: 0,
      readies: 0,
      sessionRequests: [] as Array<{
        ceiling: RuntimeMode;
        memoryScopes: ReadonlyArray<string>;
        requireReady: boolean;
      }>,
      sessions: [] as { target: DesktopSshEnvironmentTarget; ceiling: RuntimeMode }[],
    };
    const manager = SshTunnel.SshEnvironmentManager.of({
      status: () => Effect.die("Unexpected runtime status"),
      ensureEnvironment: (target) =>
        Effect.sync(() => {
          record.ensures += 1;
          record.targets.push(target);
          return {
            target,
            httpBaseUrl: "http://fixture.invalid/",
            wsBaseUrl: "ws://fixture.invalid/",
            pairingToken: null,
          };
        }),
      readyEnvironment: (target) =>
        Effect.gen(function* () {
          yield* options.beforeReady ?? Effect.void;
          record.readies += 1;
          return {
            target,
            httpBaseUrl: "http://fixture.invalid/",
            wsBaseUrl: "ws://fixture.invalid/",
            pairingToken: null,
          };
        }),
      beginSetupOperation: () => Effect.die("Unexpected setup operation"),
      publishSetupOutcome: () => Effect.succeed(true),
      publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
      forgetEnvironment: () => Effect.die("Unexpected forget"),
      disconnectEnvironment: () => Effect.void,
      revalidateTunnels: () => Effect.void,
      issueClientSession: () => Effect.die("unused"),
      issueMcpClientSession: (target, opts) =>
        Effect.gen(function* () {
          yield* options.beforeSessionIssue?.(opts.memoryScopes ?? []) ?? Effect.void;
          record.sessions.push({ target, ceiling: opts.runtimeModeCeiling as RuntimeMode });
          record.sessionRequests.push({
            ceiling: opts.runtimeModeCeiling as RuntimeMode,
            memoryScopes: opts.memoryScopes ?? [],
            requireReady: opts.requireReady === true,
          });
          return {
            token: `token-${record.sessions.length}`,
            expiresAt: null,
            runtimeModeCeilingApplied: options.ceilingApplied ?? true,
          };
        }),
      runRemoteScript: (target) =>
        Effect.sync(() => {
          record.targets.push(target);
          const path = options.broad ? "/home/agent" : launchInput.cwd;
          return {
            stdout:
              options.browseStdout ??
              `T3B\t1\nHOME\t/home/agent\nOS\tLinux\nPATH\t${path}\nREAL\t${path}\nGITROOT\t${path}\n`,
            stderr: "",
          };
        }),
    });
    const discover = vi
      .spyOn(SshConfig, "discoverSshHosts")
      .mockReturnValue(
        Effect.succeed(
          options.discoverSavedHost ? [{ ...savedTarget, source: "ssh-config" as const }] : [],
        ),
      );
    const managerLayer = vi
      .spyOn(SshTunnel.SshEnvironmentManager, "layer")
      .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
    const registrationRequests = yield* Queue.unbounded<{
      args: Record<string, unknown>;
      ceiling: RuntimeMode;
      resolve: (value: Effect.Success<ReturnType<typeof checkRegistration>>) => void;
      reject: (error: Error) => void;
    }>();
    yield* Stream.fromQueue(registrationRequests).pipe(
      Stream.runForEach((request) =>
        checkRegistration(request.args, request.ceiling).pipe(
          Effect.matchCause({
            onFailure: () => request.reject(new Error("Fake registration failed")),
            onSuccess: request.resolve,
          }),
        ),
      ),
      Effect.forkChild,
    );
    const fetchEndpoint = vi.fn(async (_url: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as {
        id?: string;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (options.rejectSession?.()) return new Response(null, { status: 401 });
      if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown;
      if (req.method === "initialize")
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "GOAT", version: "test" },
        };
      else if (req.method === "tools/list")
        result = {
          tools: [
            "goat_project_list",
            "goat_project_create",
            "goat_thread_launch",
            "goat_environment_read",
            "orchestrator_capabilities",
          ].map((name) => ({
            name,
            // Memory admission lists strictly, which requires an input schema on every tool.
            ...(options.declaresMemoryCeiling === true
              ? {
                  inputSchema: {
                    type: "object",
                    properties: name === "goat_thread_launch" ? { memoryGrantCeiling: {} } : {},
                  },
                }
              : {}),
          })),
        };
      else {
        const name = req.params?.name ?? "";
        const args = req.params?.arguments ?? {};
        const auth = new Headers(init?.headers).get("authorization");
        record.tools.push({ name, args, authorization: auth });
        if (name === "goat_thread_launch" && options.transportFailure)
          throw new TypeError("lost response");
        if (name === "goat_project_create" && options.registrationAccess) {
          const session = record.sessions[Number(auth?.split("-").at(-1)) - 1]!;
          result = await new Promise<Effect.Success<ReturnType<typeof checkRegistration>>>(
            (resolve, reject) => {
              Queue.offerUnsafe(registrationRequests, {
                args,
                ceiling: session.ceiling,
                resolve,
                reject,
              });
            },
          );
        } else {
          const value =
            name === "goat_project_list"
              ? {
                  projects:
                    options.projects ??
                    (options.existing ? [{ id: "existing", workspaceRoot: launchInput.cwd }] : []),
                  nextCursor: null,
                }
              : name === "goat_project_create"
                ? (options.projectReply ?? { id: "rp" })
                : name === "goat_environment_read"
                  ? (options.identity ?? { environmentId: "remote" })
                  : name === "orchestrator_capabilities"
                    ? (options.capabilities ?? capabilityFixture)
                    : name === "goat_origin_reports_wait"
                      ? {
                          threadId: "rt",
                          latestRunId: "run",
                          reports: [],
                          observedRun: { runId: "run", status: "running", summary: null },
                          hasMore: false,
                          timedOut: false,
                        }
                      : (options.launchReply ?? { threadId: "rt", runId: "run" });
          result = {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
            ...(name === "goat_thread_launch" && options.refusal ? { isError: true } : {}),
          };
        }
      }
      return Response.json({ jsonrpc: "2.0", id: req.id, result });
    });
    vi.stubGlobal("fetch", fetchEndpoint);
    try {
      return yield* body(record).pipe(
        Effect.provide(
          SshRemoteDispatch.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-saved-target-" })),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    } finally {
      vi.unstubAllGlobals();
      managerLayer.mockRestore();
      discover.mockRestore();
    }
  });

it.effect("launch accepts saved full target without rediscovering its alias", () =>
  withLaunchRemote({}, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const result = yield* dispatch.launchThread(launchInput, Effect.void);
      expect(result.threadId).toBe("rt");
      expect(result.runId).toBe("run");
      expect(record.targets.every((target) => target === savedTarget)).toBe(true);
      expect(record.sessions[0]?.ceiling).toBe("full-access");
    }),
  ),
);
it.effect("alias launch remains compatible", () =>
  withLaunchRemote({}, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const { target: _target, ...input } = launchInput;
      const error = yield* dispatch
        .launchThread({ ...input, host: "unknown" }, Effect.void)
        .pipe(Effect.flip);
      expect(error.reason).toBe("host_unknown");
      expect(record.targets).toHaveLength(0);
    }),
  ),
);
it.effect("issues independently for concurrent launches with different memory grant keys", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const scopes: ReadonlyArray<string>[] = [];
    yield* withLaunchRemote(
      {
        declaresMemoryCeiling: true,
        beforeSessionIssue: (requested) => {
          scopes.push(requested);
          return Deferred.succeed(
            scopes.length === 1 ? firstStarted : secondStarted,
            undefined,
          ).pipe(Effect.andThen(Deferred.await(release)));
        },
      },
      (record) =>
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          const first = yield* Effect.forkChild(
            dispatch.launchThread({ ...launchInput, memoryGrantCeiling: "none" }, Effect.void),
          );
          yield* Deferred.await(firstStarted);
          const second = yield* Effect.forkChild(
            dispatch.launchThread({ ...launchInput, memoryGrantCeiling: "read" }, Effect.void),
          );
          yield* Deferred.await(secondStarted);
          expect(scopes).toEqual([[], ["memory:read"]]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          expect(record.sessions).toHaveLength(2);
          expect(new Set(record.tools.map((call) => call.authorization)).size).toBe(2);
        }),
    );
  }),
);
it.effect("same alias different user or port gets a separate session", () =>
  withLaunchRemote({}, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      for (const target of [
        savedTarget,
        { ...savedTarget, username: "other" },
        { ...savedTarget, port: 2223 },
        { ...savedTarget, hostname: "other.test" },
        savedTarget,
      ])
        yield* dispatch.launchThread({ ...launchInput, target }, Effect.void);
      expect(record.sessions).toHaveLength(4);
      expect(
        record.tools
          .filter((call) => call.name === "goat_thread_launch")
          .map((call) => call.authorization),
      ).toEqual([
        "Bearer token-1",
        "Bearer token-2",
        "Bearer token-3",
        "Bearer token-4",
        "Bearer token-1",
      ]);
    }),
  ),
);
it.effect("scripts reach new remote project creation", () =>
  withLaunchRemote({}, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const scripts = [
        {
          id: "setup",
          name: "Setup",
          command: "echo setup",
          icon: "play" as const,
          async: true,
          runOnWorktreeCreate: true,
        },
      ];
      yield* dispatch.launchThread({ ...launchInput, scripts }, Effect.void);
      const args = record.tools.find((call) => call.name === "goat_project_create")!.args;
      expect((yield* Schema.decodeUnknownEffect(ProjectCreatePayload)(args)).scripts).toEqual(
        scripts,
      );
      expect(args).not.toHaveProperty("allowBroadWorkspaceRoot");
    }),
  ),
);

const gitBashBrowse = [
  "T3B\t1",
  "HOME\t/c/Users/super",
  "OS\tMINGW64_NT-10.0-26200",
  "PATH\t/c/Users/super/Developer/goat",
  "REAL\t/c/Users/super/Developer/goat",
  "GITROOT\tC:/Users/super/Developer/goat",
  "BRANCH\tdev",
  "",
].join("\n");
it.effect("a Git Bash host gets its new project and worktree paths in native Windows form", () =>
  withLaunchRemote({ browseStdout: gitBashBrowse }, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const result = yield* dispatch.launchThread(
        {
          ...launchInput,
          cwd: "/c/Users/super/Developer/goat",
          workspace: {
            type: "existing_worktree",
            worktreePath: "/c/Users/super/.goat/worktrees/goat/x/",
          },
        },
        Effect.void,
      );
      expect(record.tools.find((call) => call.name === "goat_project_create")?.args).toMatchObject({
        title: "goat",
        workspaceRoot: "C:\\Users\\super\\Developer\\goat",
      });
      expect(
        record.tools.find((call) => call.name === "goat_thread_launch")?.args.workspaceStrategy,
      ).toEqual({
        type: "existing_worktree",
        worktreePath: "C:\\Users\\super\\.goat\\worktrees\\goat\\x",
      });
      expect(result.cwd).toBe("C:\\Users\\super\\Developer\\goat");
    }),
  ),
);
it.effect("a Git Bash host reuses its project stored in Windows form", () =>
  withLaunchRemote(
    {
      browseStdout: gitBashBrowse,
      projects: [{ id: "windows", workspaceRoot: "c:\\users\\Super\\Developer\\goat\\" }],
    },
    (record) =>
      Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        const result = yield* dispatch.launchThread(
          { ...launchInput, cwd: "C:\\Users\\super\\Developer\\goat" },
          Effect.void,
        );
        expect(result.projectId).toBe("windows");
        expect(record.tools.map((call) => call.name)).toEqual([
          "goat_project_list",
          "goat_thread_launch",
        ]);
      }),
  ),
);

it.effect("existing remote project retains scripts", () =>
  withLaunchRemote({ existing: true }, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      yield* dispatch.launchThread({ ...launchInput, scripts: [] }, Effect.void);
      expect(record.tools.map((call) => call.name)).toEqual([
        "goat_project_list",
        "goat_thread_launch",
      ]);
    }),
  ),
);
it.effect.each(
  [{ ceilingApplied: false }, { identity: { environmentId: " " } }, { capabilities: {} }].map(
    (opts) =>
      [
        `preflight reads actual environment identity and refuses old remote ${JSON.stringify(opts)}`,
        opts,
      ] as const,
  ),
)("%s", ([_name, opts]) =>
  withLaunchRemote(opts, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const result = yield* dispatch
        .preflightTarget({
          target: savedTarget,
          runtimeMode: "full-access",
          modelSelection: launchInput.modelSelection!,
        })
        .pipe(Effect.flip);
      expect(result.reason).toBe("remote_refused");
      expect(record.tools.some((call) => call.name === "goat_thread_launch")).toBe(false);
    }),
  ),
);
it.effect("preflight reads actual environment identity and selected model", () =>
  withLaunchRemote({}, () =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      expect(
        yield* dispatch.preflightTarget({
          target: savedTarget,
          runtimeMode: "full-access",
          modelSelection: launchInput.modelSelection!,
        }),
      ).toEqual({ environmentId: "remote" });
      for (const selection of [
        { instanceId: ProviderInstanceId.make("missing"), model: "model" },
        { instanceId: ProviderInstanceId.make("codex"), model: "missing" },
      ])
        expect(
          (yield* dispatch
            .preflightTarget({
              target: savedTarget,
              runtimeMode: "full-access",
              modelSelection: selection,
            })
            .pipe(Effect.flip)).remoteCode,
        ).toBe("model_unavailable");
    }),
  ),
);
it.effect.each(
  [{ transportFailure: true }, { launchReply: {} }, { launchReply: { threadId: " " } }].map(
    (opts) =>
      [
        `launch missing acknowledgement is uncertain and not retried ${JSON.stringify(opts)}`,
        opts,
      ] as const,
  ),
)("%s", ([_name, opts]) =>
  withLaunchRemote(opts, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      expect(
        (yield* dispatch.launchThread(launchInput, Effect.void).pipe(Effect.flip))
          .launchMayHaveStarted,
      ).toBe(true);
      expect(record.tools.filter((call) => call.name === "goat_thread_launch")).toHaveLength(1);
    }),
  ),
);
it.effect("structured remote refusal is definite", () =>
  withLaunchRemote(
    { refusal: true, launchReply: { code: "invalid_request", message: "refused" } },
    (record) =>
      Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        const error = yield* dispatch.launchThread(launchInput, Effect.void).pipe(Effect.flip);
        expect(error.reason).toBe("remote_refused");
        expect(error.launchMayHaveStarted).toBeUndefined();
        expect(record.tools.filter((call) => call.name === "goat_thread_launch")).toHaveLength(1);
      }),
  ),
);
it.effect("first registration permits an approval-required thread under full-access ceiling", () =>
  withLaunchRemote({ registrationAccess: true }, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      yield* dispatch.launchThread(launchInput, Effect.void);
      expect(record.sessions[0]?.ceiling).toBe("full-access");
      expect(
        record.tools.find((call) => call.name === "goat_thread_launch")?.args.runtimeMode,
      ).toBe("approval-required");
      const refused = yield* dispatch
        .launchThread({ ...launchInput, callerRuntimeMode: "approval-required" }, Effect.void)
        .pipe(Effect.flip);
      expect(refused.reason).toBe("remote_refused");
      expect(record.tools.filter((call) => call.name === "goat_thread_launch")).toHaveLength(1);
    }),
  ),
);
it.effect("full target keeps broad-root guard and explicit override", () =>
  withLaunchRemote({ broad: true }, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      expect(
        (yield* dispatch.launchThread(launchInput, Effect.void).pipe(Effect.flip)).reason,
      ).toBe("invalid_request");
      expect(record.tools).toHaveLength(0);
      yield* dispatch.launchThread({ ...launchInput, allowBroadWorkspaceRoot: true }, Effect.void);
      expect(
        record.tools.find((call) => call.name === "goat_project_create")?.args,
      ).not.toHaveProperty("allowBroadWorkspaceRoot");
    }),
  ),
);
it.effect("invalid project acknowledgement refuses before launch", () =>
  withLaunchRemote({ projectReply: { id: " " } }, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      expect(
        (yield* dispatch.launchThread(launchInput, Effect.void).pipe(Effect.flip))
          .launchMayHaveStarted,
      ).toBeUndefined();
      expect(record.tools.some((call) => call.name === "goat_thread_launch")).toBe(false);
    }),
  ),
);

describe("SSH dispatch launch lineage", () => {
  const launcher = {
    kind: "launch" as const,
    threadId: ThreadId.make("orchestrator"),
    environmentId: EnvironmentId.make("launcher-environment"),
    environmentLabel: "studio",
    threadTitle: "Orchestrator",
  };

  const reportBinding = {
    correlationId: "rr-lineage",
    originLabel: "studio",
    originThreadId: ThreadId.make("orchestrator"),
    readKeyHash: "0".repeat(64),
  };

  /** Launches against a fake remote and returns the arguments goat_thread_launch received. */
  const launchAgainst = (remote: {
    readonly permissionProfileCeiling?: import("@goat/contracts").PermissionProfile;
    readonly declaresPermissionProfile?: boolean;
    readonly declaresLaunchedBy: boolean;
    readonly coordinatorKind?: "thread" | "task";
    readonly refuseLaunchedBy?: boolean;
    readonly afterLaunchedByRefusal?: {
      readonly advertisesMemory: boolean;
      readonly declaresMemoryCeiling: boolean;
      readonly listFailure?: "failed" | "timeout" | "malformed" | "malformed-entry";
    };
    readonly callerRuntimeMode?: SshRemoteDispatch.SshLaunchInput["callerRuntimeMode"];
    readonly standingInstructions?: false;
    readonly refuseReport?: boolean;
    readonly afterReportRefusal?: {
      readonly advertisesMemory: boolean;
      readonly declaresMemoryCeiling: boolean;
      readonly listFailure?: "failed" | "timeout" | "malformed" | "malformed-entry";
    };
    readonly afterFirstLaunch?: {
      readonly advertisesMemory: boolean;
      readonly declaresMemoryCeiling: boolean;
      readonly listFailure?: "failed" | "timeout" | "malformed" | "malformed-entry";
    };
    readonly declaresStandingInstructions?: boolean;
    readonly listFailure?: "failed" | "timeout" | "malformed" | "malformed-entry";
    readonly onList?: () => void;
    readonly memoryCeilings?: ReadonlyArray<import("@goat/contracts").MemoryTaskGrantCeiling>;
    readonly declaresMemoryCeiling?: boolean;
    readonly advertisesMemory?: boolean;
    readonly onMemoryLaunch?: () => void;
    readonly declaresReport?: boolean;
    readonly declaresNotifyOnCompletion?: boolean;
    /** Launch for an outside client, with no launching thread. */
    readonly outside?: boolean;
    /** Launch with a report binding and its agent note. */
    readonly withReport?: boolean;
    /** Launch twice through one dispatch service; the remote declares report from the second. */
    readonly upgradeBetweenLaunches?: boolean;
    readonly listFails?: boolean;
    /** The listing never answers until the caller gives up and aborts it. */
    readonly onListStalled?: () => void;
  }) =>
    Effect.gen(function* () {
      const host = "lineage-host";
      const target = { alias: host, hostname: host, username: null, port: null };
      const launches: Array<Record<string, unknown>> = [];
      const memorySessions: Array<ReadonlyArray<string>> = [];
      const presentedTokens: Array<string | null> = [];
      let declaresReport = remote.declaresReport === true;
      let reportRefused = false;
      let launchedByRefused = false;
      const fetchEndpoint = vi.fn(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          id?: string;
          method: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        switch (request.method) {
          case "initialize":
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "GOAT", version: "fixture" },
              },
            });
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list": {
            remote.onList?.();
            const catalog =
              launchedByRefused && remote.afterLaunchedByRefusal !== undefined
                ? remote.afterLaunchedByRefusal
                : reportRefused && remote.afterReportRefusal !== undefined
                  ? remote.afterReportRefusal
                  : launches.length > 0 && remote.afterFirstLaunch !== undefined
                    ? remote.afterFirstLaunch
                    : remote;
            const listFailure = "listFailure" in catalog ? catalog.listFailure : undefined;
            if (listFailure === "failed") return new Response(null, { status: 500 });
            if (listFailure === "malformed" || listFailure === "malformed-entry")
              return Response.json({
                jsonrpc: "2.0",
                id: request.id,
                result: { tools: listFailure === "malformed" ? {} : [null] },
              });
            if (remote.listFails === true) return new Response(null, { status: 500 });
            if (
              listFailure === "timeout" ||
              (remote.onListStalled !== undefined &&
                remote.listFailure === undefined &&
                remote.afterReportRefusal?.listFailure === undefined &&
                remote.afterLaunchedByRefusal?.listFailure === undefined &&
                remote.afterFirstLaunch?.listFailure === undefined)
            ) {
              remote.onListStalled?.();
              return new Promise<Response>((_resolve, reject) =>
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
              );
            }
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                tools: [
                  ...(catalog.advertisesMemory
                    ? [{ name: "memory_search", inputSchema: { type: "object", properties: {} } }]
                    : []),
                  {
                    name: "goat_thread_launch",
                    inputSchema: {
                      type: "object",
                      properties: {
                        title: { type: "string" },
                        ...(remote.declaresPermissionProfile
                          ? { permissionProfileCeiling: { type: "object" } }
                          : {}),
                        ...(catalog.declaresMemoryCeiling
                          ? { memoryGrantCeiling: { type: "string" } }
                          : {}),
                        ...(remote.declaresLaunchedBy ? { launchedBy: { type: "object" } } : {}),
                        ...(declaresReport ? { report: { type: "object" } } : {}),
                        ...(remote.declaresStandingInstructions
                          ? { standingInstructions: { type: "boolean" } }
                          : {}),
                        ...(remote.declaresNotifyOnCompletion === true
                          ? { notifyOnCompletion: { type: "boolean" } }
                          : {}),
                      },
                    },
                  },
                ],
              },
            });
          }
          case "tools/call": {
            if (request.params?.name === "goat_thread_launch") {
              remote.onMemoryLaunch?.();
              presentedTokens.push(new Headers(init?.headers).get("authorization"));
              launches.push(request.params.arguments ?? {});
            }
            if (
              remote.refuseLaunchedBy &&
              request.params?.name === "goat_thread_launch" &&
              request.params.arguments?.launchedBy !== undefined
            ) {
              launchedByRefused = true;
              return Response.json({
                jsonrpc: "2.0",
                id: request.id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "goat_thread_launch does not take launchedBy, so nothing ran",
                    },
                  ],
                },
              });
            }
            const report = request.params?.arguments?.report as
              | { readonly correlationId: string }
              | undefined;
            if (remote.refuseReport && report !== undefined) {
              reportRefused = true;
              return Response.json({
                jsonrpc: "2.0",
                id: request.id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "goat_thread_launch does not take report, so nothing ran.",
                    },
                  ],
                },
              });
            }
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                structuredContent: {
                  projects: [],
                  id: "new-project",
                  threadId: "new-thread",
                  ...(report === undefined
                    ? {}
                    : { report: { correlationId: report.correlationId } }),
                },
              },
            });
          }
          default:
            throw new Error(`Unexpected remote method: ${request.method}`);
        }
      });
      const manager = SshTunnel.SshEnvironmentManager.of({
        status: () => Effect.die("Unexpected runtime status"),
        ensureEnvironment: () =>
          Effect.succeed({
            target,
            httpBaseUrl: "http://lineage-host:3773/",
            wsBaseUrl: "ws://lineage-host:3773/",
            pairingToken: null,
          }),
        readyEnvironment: () => Effect.die("Unexpected ready environment"),
        beginSetupOperation: () => Effect.die("Unexpected setup operation"),
        publishSetupOutcome: () => Effect.succeed(true),
        publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
        forgetEnvironment: () => Effect.die("Unexpected forget"),
        disconnectEnvironment: () => Effect.die("Unexpected SSH disconnect"),
        revalidateTunnels: () => Effect.void,
        issueClientSession: () => Effect.die("unused"),
        issueMcpClientSession: (_target, options) =>
          Effect.sync(() => {
            memorySessions.push(options.memoryScopes ?? []);
            return {
              token: `fixture-session-${memorySessions.length}`,
              expiresAt: null,
              runtimeModeCeilingApplied: true,
            };
          }),
        runRemoteScript: () =>
          Effect.succeed({
            stdout:
              "T3B\t1\nHOME\t/home/agent\nOS\tLinux\nPATH\t/home/agent/repo\nREAL\t/home/agent/repo\n",
            stderr: "",
          }),
      });
      const discoverHosts = vi
        .spyOn(SshConfig, "discoverSshHosts")
        .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
      const managerLayer = vi
        .spyOn(SshTunnel.SshEnvironmentManager, "layer")
        .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
      vi.stubGlobal("fetch", fetchEndpoint);
      try {
        const result = yield* Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          const launch = (
            memoryGrantCeiling?: import("@goat/contracts").MemoryTaskGrantCeiling,
          ) => {
            const input: SshRemoteDispatch.SshLaunchInput = {
              host,
              cwd: "/home/agent/repo",
              workspace: { type: "cwd" },
              title: "Lineage probe",
              ...(remote.permissionProfileCeiling === undefined
                ? {}
                : { permissionProfileCeiling: remote.permissionProfileCeiling }),
              ...(memoryGrantCeiling === undefined ? {} : { memoryGrantCeiling }),
              runtimeMode: "approval-required",
              callerRuntimeMode: remote.callerRuntimeMode ?? "approval-required",
              ...(remote.standingInstructions === false ? { standingInstructions: false } : {}),
              ...(remote.outside === true ? {} : { launchedBy: launcher }),
              ...(remote.withReport === true
                ? { message: "Do the work", report: reportBinding, reportNote: "Report back." }
                : {}),
            };
            if (remote.coordinatorKind === undefined)
              return dispatch.launchThread(input, Effect.void);
            return Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* Migration0062;
              yield* Migration0063;
              yield* Migration0065;
              yield* Migration0068;
              yield* sql`CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY)`;
              yield* Migration0073;
              return yield* Effect.gen(function* () {
                const coordinator = yield* Coordinator.RemoteDispatchCoordinator;
                const launched = yield* coordinator.launch(
                  {
                    kind: remote.coordinatorKind!,
                    originThreadId: launcher.threadId,
                    delivery: "notify_only",
                    launch: input,
                    ...(remote.coordinatorKind === "task"
                      ? {
                          task: {
                            taskId: NodeId.make("fixture-task"),
                            parentRunId: RunId.make("fixture-parent-run"),
                          },
                        }
                      : {}),
                  },
                  Effect.void,
                );
                const stored = yield* coordinator.get(launched.correlationId);
                expect(stored?.memoryGrantCeiling).toBe(memoryGrantCeiling ?? "none");
                return launched.launch;
              }).pipe(
                Effect.provide(
                  Coordinator.layer.pipe(
                    Layer.provide(
                      Layer.mergeAll(
                        Layer.succeed(SqlClient.SqlClient, sql),
                        Layer.succeed(SshRemoteDispatch.SshRemoteDispatch, dispatch),
                        Layer.mock(ThreadManagement.ThreadManagementService)({
                          getThreadShell: () => Effect.succeed(null),
                          dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
                        }),
                        Layer.mock(LaunchWatchService.LaunchWatchService)({}),
                      ),
                    ),
                  ),
                ),
              );
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
          };
          if (remote.memoryCeilings !== undefined) {
            let result;
            for (const ceiling of remote.memoryCeilings) result = yield* launch(ceiling);
            return result!;
          }
          if (remote.upgradeBetweenLaunches !== true) return yield* launch();
          yield* launch();
          declaresReport = true;
          return yield* launch();
        }).pipe(
          Effect.provide(
            SshRemoteDispatch.layer.pipe(
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-dispatch-test-" })),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        return { result, launches, memorySessions, presentedTokens };
      } finally {
        vi.unstubAllGlobals();
        managerLayer.mockRestore();
        discoverHosts.mockRestore();
      }
    });

  it.effect.each([false, true])(
    "requires profile-ceiling support before a remote launch, supported=%s",
    (supported) =>
      Effect.gen(function* () {
        let attempts = 0;
        const result = yield* launchAgainst({
          declaresLaunchedBy: false,
          declaresPermissionProfile: supported,
          permissionProfileCeiling: BUILTIN_PERMISSION_PROFILES.worker!,
          onMemoryLaunch: () => {
            attempts += 1;
          },
        }).pipe(Effect.result);
        if (result._tag === "Success") {
          expect(supported).toBe(true);
          expect(result.success.launches[0]?.permissionProfileCeiling).toEqual(
            BUILTIN_PERMISSION_PROFILES.worker,
          );
        } else {
          expect(supported).toBe(false);
          expect(result.failure).toMatchObject({ remoteCode: "permission_profile_unsupported" });
          expect(attempts).toBe(0);
        }
      }),
  );

  it.effect("issues and reuses SSH sessions only within a task memory ceiling in both orders", () =>
    Effect.gen(function* () {
      for (const ceilings of [
        ["none", "read_write", "read", "none", "read_write", "read"],
        ["read", "read_write", "none", "read", "read_write", "none"],
      ] as const) {
        const { launches, memorySessions, presentedTokens } = yield* launchAgainst({
          declaresLaunchedBy: true,
          declaresMemoryCeiling: true,
          advertisesMemory: true,
          memoryCeilings: ceilings,
        });
        expect(launches.map((launch) => launch.memoryGrantCeiling)).toEqual(ceilings);
        const scopes = (ceiling: string) =>
          ceiling === "none"
            ? []
            : ceiling === "read"
              ? ["memory:read"]
              : ["memory:read", "memory:write"];
        expect(memorySessions).toEqual(ceilings.slice(0, 3).map(scopes));
        expect(presentedTokens).toEqual([
          "Bearer fixture-session-1",
          "Bearer fixture-session-2",
          "Bearer fixture-session-3",
          "Bearer fixture-session-1",
          "Bearer fixture-session-2",
          "Bearer fixture-session-3",
        ]);
      }
    }),
  );

  it.effect("refuses a memory-advertising destination that lacks ceiling admission", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const result = yield* launchAgainst({
        declaresLaunchedBy: true,
        advertisesMemory: true,
        onMemoryLaunch: () => {
          attempts += 1;
        },
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(attempts).toBe(0);
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          reason: "remote_refused",
          remoteCode: SshRemoteDispatch.MEMORY_CEILING_UNSUPPORTED,
        });
    }),
  );

  it.effect("allows explicit none without adding memory scope on a legacy destination", () =>
    Effect.gen(function* () {
      const { launches, memorySessions } = yield* launchAgainst({
        declaresLaunchedBy: true,
        memoryCeilings: ["none"],
      });
      expect(launches).toHaveLength(1);
      expect(launches[0]).not.toHaveProperty("memoryGrantCeiling");
      expect(memorySessions).toEqual([[]]);
    }),
  );

  it.effect.each([
    ["ordinary omitted", "thread", undefined, false, false, true],
    ["task none", "task", "none", false, false, true],
    ["task none with admission without memory", "task", "none", false, true, true],
    ["ordinary omitted memory without admission", "thread", undefined, true, false, false],
    ["task read", "task", "read", false, false, false],
    ["task read with admission without memory", "task", "read", false, true, true],
    ["task read_write", "task", "read_write", false, false, false],
    ["memory without admission none", "task", "none", true, false, false],
    ["memory without admission read", "task", "read", true, false, false],
    ["memory with admission none", "task", "none", true, true, true],
    ["memory with admission read", "task", "read", true, true, true],
  ] as const)("coordinator → SSH consumer: %s", ([, kind, ceiling, memory, admission, allowed]) =>
    Effect.gen(function* () {
      let attempts = 0;
      const result = yield* launchAgainst({
        declaresLaunchedBy: true,
        coordinatorKind: kind,
        ...(ceiling === undefined ? {} : { memoryCeilings: [ceiling] }),
        advertisesMemory: memory,
        declaresMemoryCeiling: admission,
        onMemoryLaunch: () => {
          attempts += 1;
        },
      }).pipe(Effect.result);
      expect(attempts).toBe(allowed ? 1 : 0);
      expect(result._tag).toBe(allowed ? "Success" : "Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          reason: "remote_refused",
          remoteCode: SshRemoteDispatch.MEMORY_CEILING_UNSUPPORTED,
        });
      } else {
        expect(result.success.memorySessions).toEqual([ceiling === "read" ? ["memory:read"] : []]);
        if (admission && (memory || ceiling === "read"))
          expect(result.success.launches[0]?.memoryGrantCeiling).toBe(ceiling);
        else expect(result.success.launches[0]).not.toHaveProperty("memoryGrantCeiling");
      }
    }),
  );

  it.effect.each([
    ["ordinary omitted legacy", "thread", undefined, false, false, true],
    ["task none legacy", "task", "none", false, false, true],
    ["task read loses admission", "task", "read", false, false, false],
    ["memory none loses admission", "task", "none", true, false, false],
    ["memory read loses admission", "task", "read", true, false, false],
    ["memory none keeps admission", "task", "none", true, true, true],
    ["memory read keeps admission", "task", "read", true, true, true],
  ] as const)(
    "coordinator report fallback → SSH consumer: %s",
    ([, kind, ceiling, memory, admission, allowed]) =>
      Effect.gen(function* () {
        let attempts = 0;
        const result = yield* launchAgainst({
          declaresLaunchedBy: true,
          coordinatorKind: kind,
          ...(ceiling === undefined ? {} : { memoryCeilings: [ceiling] }),
          declaresMemoryCeiling: ceiling === "read",
          declaresReport: true,
          refuseReport: true,
          declaresStandingInstructions: true,
          afterReportRefusal: { advertisesMemory: memory, declaresMemoryCeiling: admission },
          onMemoryLaunch: () => {
            attempts += 1;
          },
        }).pipe(Effect.result);
        expect(attempts).toBe(allowed ? 2 : 1);
        expect(result._tag).toBe(allowed ? "Success" : "Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            reason: "remote_refused",
            remoteCode: SshRemoteDispatch.MEMORY_CEILING_UNSUPPORTED,
          });
        } else {
          const launches = result.success.launches;
          expect(launches[0]).toHaveProperty("report");
          expect(launches[1]).not.toHaveProperty("report");
          if (admission) expect(launches[1]?.memoryGrantCeiling).toBe(ceiling);
          else
            for (const launch of launches) expect(launch).not.toHaveProperty("memoryGrantCeiling");
          expect(result.success.memorySessions).toEqual([
            ceiling === "read" ? ["memory:read"] : [],
          ]);
        }
      }),
  );

  it.effect.each([
    ["memory false → true with admission", false, true, true, true, true],
    ["memory false → true without admission", false, true, true, false, false],
    ["admission lost", true, true, true, false, false],
    ["memory true → false", true, true, false, false, true],
  ] as const)(
    "fresh cached catalog: %s",
    ([, initialMemory, initialAdmission, memory, admission, allowed]) =>
      Effect.gen(function* () {
        for (const fallback of [false, true]) {
          let attempts = 0;
          let lists = 0;
          const updated = { advertisesMemory: memory, declaresMemoryCeiling: admission };
          const result = yield* launchAgainst({
            declaresLaunchedBy: true,
            coordinatorKind: "task",
            memoryCeilings: fallback ? ["none"] : ["none", "none"],
            advertisesMemory: initialMemory,
            declaresMemoryCeiling: initialAdmission,
            declaresReport: true,
            declaresStandingInstructions: true,
            ...(fallback
              ? { refuseReport: true, afterReportRefusal: updated }
              : { afterFirstLaunch: updated }),
            onList: () => {
              lists += 1;
            },
            onMemoryLaunch: () => {
              attempts += 1;
            },
          }).pipe(Effect.result);
          expect(lists).toBe(2);
          expect(attempts).toBe(allowed ? 2 : 1);
          expect(result._tag).toBe(allowed ? "Success" : "Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toMatchObject({
              reason: "remote_refused",
              remoteCode: SshRemoteDispatch.MEMORY_CEILING_UNSUPPORTED,
            });
          } else {
            expect(result.success.memorySessions).toEqual([[]]);
            expect(new Set(result.success.presentedTokens).size).toBe(1);
            if (memory) expect(result.success.launches[1]?.memoryGrantCeiling).toBe("none");
            else expect(result.success.launches[1]).not.toHaveProperty("memoryGrantCeiling");
          }
        }
      }),
  );

  it.effect.each(["failed", "timeout", "malformed", "malformed-entry"] as const)(
    "catalog %s refuses explicit ceilings before first launch and fallback",
    (listFailure) =>
      Effect.gen(function* () {
        for (const ceiling of ["none", "read"] as const) {
          for (const fallback of [false, true]) {
            let attempts = 0;
            let lists = 0;
            let listStalled!: () => void;
            const stalled = new Promise<void>((resolve) => {
              listStalled = resolve;
            });
            const operation = launchAgainst({
              declaresLaunchedBy: true,
              coordinatorKind: "task",
              memoryCeilings: [ceiling],
              advertisesMemory: true,
              declaresMemoryCeiling: true,
              declaresReport: true,
              declaresStandingInstructions: true,
              ...(fallback
                ? {
                    refuseReport: true,
                    afterReportRefusal: {
                      advertisesMemory: true,
                      declaresMemoryCeiling: true,
                      listFailure,
                    },
                  }
                : { listFailure }),
              onList: () => {
                lists += 1;
              },
              ...(listFailure === "timeout" ? { onListStalled: listStalled } : {}),
              onMemoryLaunch: () => {
                attempts += 1;
              },
            }).pipe(Effect.result);
            const fiber = yield* Effect.forkChild(operation);
            if (listFailure === "timeout") {
              yield* Effect.promise(() => stalled);
              yield* TestClock.adjust(SshRemoteDispatch.LAUNCH_LINEAGE_PROBE_TIMEOUT);
            }
            const result = yield* Fiber.join(fiber);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect(result.failure).toMatchObject({
                reason: "remote_refused",
                remoteCode: SshRemoteDispatch.MEMORY_CEILING_UNSUPPORTED,
              });
            expect(attempts).toBe(fallback ? 1 : 0);
            expect(lists).toBe(fallback ? 2 : 1);
          }
        }
      }),
  );

  it.effect.each(["failed", "timeout", "malformed", "malformed-entry"] as const)(
    "ordinary coordinator omitted ceiling preserves compatibility on catalog %s",
    (listFailure) =>
      Effect.gen(function* () {
        let listStalled!: () => void;
        const stalled = new Promise<void>((resolve) => {
          listStalled = resolve;
        });
        const fiber = yield* Effect.forkChild(
          launchAgainst({
            declaresLaunchedBy: true,
            coordinatorKind: "thread",
            listFailure,
            ...(listFailure === "timeout" ? { onListStalled: listStalled } : {}),
          }),
        );
        if (listFailure === "timeout") {
          yield* Effect.promise(() => stalled);
          yield* TestClock.adjust(SshRemoteDispatch.LAUNCH_LINEAGE_PROBE_TIMEOUT);
        }
        const { launches, memorySessions } = yield* Fiber.join(fiber);
        expect(launches).toHaveLength(1);
        expect(launches[0]).not.toHaveProperty("memoryGrantCeiling");
        expect(memorySessions).toEqual([[]]);
      }),
  );

  it.effect.each([
    ["none, memory false → true with admission", "none", false, true, true, true],
    ["none, memory false → true without admission", "none", false, true, false, false],
    ["read, admission lost", "read", true, true, false, false],
  ] as const)(
    "launchedBy retry fresh admission: %s",
    ([, ceiling, initialMemory, memory, admission, allowed]) =>
      Effect.gen(function* () {
        let lists = 0;
        let attempts = 0;
        const result = yield* launchAgainst({
          declaresLaunchedBy: true,
          memoryCeilings: [ceiling],
          advertisesMemory: initialMemory,
          declaresMemoryCeiling: true,
          declaresReport: true,
          declaresStandingInstructions: true,
          refuseLaunchedBy: true,
          afterLaunchedByRefusal: { advertisesMemory: memory, declaresMemoryCeiling: admission },
          onList: () => {
            lists += 1;
          },
          onMemoryLaunch: () => {
            attempts += 1;
          },
        }).pipe(Effect.result);
        expect(lists).toBe(2);
        expect(attempts).toBe(allowed ? 2 : 1);
        expect(result._tag).toBe(allowed ? "Success" : "Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            reason: "remote_refused",
            remoteCode: SshRemoteDispatch.MEMORY_CEILING_UNSUPPORTED,
          });
        } else {
          expect(result.success.memorySessions).toEqual([[]]);
          expect(new Set(result.success.presentedTokens).size).toBe(1);
          expect(result.success.launches[0]).toHaveProperty("launchedBy");
          expect(result.success.launches[0]).not.toHaveProperty("memoryGrantCeiling");
          expect(result.success.launches[1]).not.toHaveProperty("launchedBy");
          expect(result.success.launches[1]?.memoryGrantCeiling).toBe("none");
        }
      }),
  );

  it.effect.each(["failed", "timeout", "malformed", "malformed-entry"] as const)(
    "launchedBy retry catalog %s gates explicit ceilings and preserves omission",
    (listFailure) =>
      Effect.gen(function* () {
        for (const ceiling of ["none", "read", undefined] as const) {
          let lists = 0;
          let attempts = 0;
          let listStalled!: () => void;
          const stalled = new Promise<void>((resolve) => {
            listStalled = resolve;
          });
          const fiber = yield* Effect.forkChild(
            launchAgainst({
              declaresLaunchedBy: true,
              ...(ceiling === undefined ? {} : { memoryCeilings: [ceiling] }),
              advertisesMemory: ceiling !== undefined,
              declaresMemoryCeiling: true,
              declaresReport: true,
              declaresStandingInstructions: true,
              refuseLaunchedBy: true,
              afterLaunchedByRefusal: {
                advertisesMemory: true,
                declaresMemoryCeiling: true,
                listFailure,
              },
              onList: () => {
                lists += 1;
              },
              onMemoryLaunch: () => {
                attempts += 1;
              },
              ...(listFailure === "timeout" ? { onListStalled: listStalled } : {}),
            }).pipe(Effect.result),
          );
          if (listFailure === "timeout") {
            yield* Effect.promise(() => stalled);
            yield* TestClock.adjust(SshRemoteDispatch.LAUNCH_LINEAGE_PROBE_TIMEOUT);
          }
          const result = yield* Fiber.join(fiber);
          expect(lists).toBe(2);
          expect(attempts).toBe(ceiling === undefined ? 2 : 1);
          expect(result._tag).toBe(ceiling === undefined ? "Success" : "Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toMatchObject({
              reason: "remote_refused",
              remoteCode: SshRemoteDispatch.MEMORY_CEILING_UNSUPPORTED,
            });
          } else {
            expect(result.success.memorySessions).toEqual([[]]);
            expect(new Set(result.success.presentedTokens).size).toBe(1);
            expect(result.success.launches[1]).not.toHaveProperty("launchedBy");
            for (const launch of result.success.launches)
              expect(launch).not.toHaveProperty("memoryGrantCeiling");
          }
        }
      }),
  );

  it.effect("optional cache uses caller mode when requested mode differs", () =>
    Effect.gen(function* () {
      let lists = 0;
      const { launches, memorySessions, presentedTokens } = yield* launchAgainst({
        declaresLaunchedBy: true,
        callerRuntimeMode: "full-access",
        standingInstructions: false,
        declaresReport: true,
        declaresStandingInstructions: true,
        declaresNotifyOnCompletion: true,
        upgradeBetweenLaunches: true,
        advertisesMemory: false,
        declaresMemoryCeiling: false,
        afterFirstLaunch: {
          advertisesMemory: false,
          declaresMemoryCeiling: false,
          listFailure: "failed",
        },
        onList: () => {
          lists += 1;
        },
      });
      expect(lists).toBe(2);
      expect(launches).toHaveLength(2);
      expect(memorySessions).toEqual([[]]);
      expect(new Set(presentedTokens).size).toBe(1);
      for (const launch of launches) {
        expect(launch.runtimeMode).toBe("approval-required");
        expect(launch.launchedBy).toMatchObject(launcher);
        expect(launch.notifyOnCompletion).toBe(false);
        expect(launch.standingInstructions).toBe(false);
        expect(launch).not.toHaveProperty("memoryGrantCeiling");
      }
    }),
  );

  it.effect("asks a remote that can be told not to watch the launch it is forwarded", () =>
    Effect.gen(function* () {
      // An outside client's launch carries no launcher, so only this keeps the
      // remote from watching it as its own outside launch.
      for (const [remote, optOut] of [
        [{ declaresLaunchedBy: true, declaresNotifyOnCompletion: true, outside: true }, false],
        [{ declaresLaunchedBy: true, declaresNotifyOnCompletion: true }, false],
        [{ declaresLaunchedBy: true, outside: true }, undefined],
      ] as const) {
        const { launches } = yield* launchAgainst(remote);
        expect(launches).toHaveLength(1);
        expect(launches[0]?.notifyOnCompletion).toBe(optOut);
      }
    }),
  );

  it.effect("forwards the launcher to a remote whose goat_thread_launch declares it", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* launchAgainst({ declaresLaunchedBy: true });
      expect(result.threadId).toBe("new-thread");
      expect(launches).toHaveLength(1);
      expect(launches[0]?.launchedBy).toEqual({ ...launcher, via: "ssh_thread_launch" });
    }),
  );

  it.effect("sends the report binding and its note only to a remote that may take it", () =>
    Effect.gen(function* () {
      for (const [remote, sent] of [
        [{ declaresLaunchedBy: true, declaresReport: true }, true],
        [{ declaresLaunchedBy: true, declaresReport: false }, false],
        // An unknown listing still sends it; a refusal is retried by the coordinator.
        [{ declaresLaunchedBy: true, listFails: true }, true],
      ] as const) {
        const { result, launches } = yield* launchAgainst({ ...remote, withReport: true });
        expect(launches).toHaveLength(1);
        expect(launches[0]?.report).toEqual(sent ? reportBinding : undefined);
        expect(launches[0]?.message).toBe(sent ? "Do the work\n\nReport back." : "Do the work");
        expect(result.reportsSupported).toBe(sent);
      }
    }),
  );

  it.effect("sends the report binding once an older remote is upgraded in the same session", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* launchAgainst({
        declaresLaunchedBy: true,
        withReport: true,
        upgradeBetweenLaunches: true,
      });
      expect(launches.map((launch) => launch.report)).toEqual([undefined, reportBinding]);
      expect(result.reportsSupported).toBe(true);
    }),
  );

  it.effect("launches once without the launcher on an older remote or a failed listing", () =>
    Effect.gen(function* () {
      for (const remote of [
        { declaresLaunchedBy: false },
        { declaresLaunchedBy: true, listFails: true },
      ]) {
        const { result, launches } = yield* launchAgainst(remote);
        expect(result.threadId).toBe("new-thread");
        expect(launches).toHaveLength(1);
        expect(launches[0]).not.toHaveProperty("launchedBy");
      }
    }),
  );

  it.effect("launches once without the launcher when the remote never answers the listing", () =>
    Effect.gen(function* () {
      let listStalled!: () => void;
      const stalled = new Promise<void>((resolve) => {
        listStalled = resolve;
      });
      const launch = yield* Effect.forkChild(
        launchAgainst({ declaresLaunchedBy: true, onListStalled: () => listStalled() }),
      );
      yield* Effect.promise(() => stalled);
      yield* TestClock.adjust(SshRemoteDispatch.LAUNCH_LINEAGE_PROBE_TIMEOUT);
      const { result, launches } = yield* Fiber.join(launch);
      expect(result.threadId).toBe("new-thread");
      expect(launches).toHaveLength(1);
      expect(launches[0]).not.toHaveProperty("launchedBy");
    }),
  );
});
it.effect.each(["matching", "missing", "wrong"] as const)(
  "report support requires %s echo",
  (echo) =>
    Effect.gen(function* () {
      const host = "report-box";
      const target = { alias: host, hostname: host, username: null, port: null };
      const binding = {
        correlationId: "rr-fixture",
        originLabel: "fixture",
        originThreadId: ThreadId.make("origin"),
        readKeyHash: "a".repeat(64),
      };
      let sent: Record<string, unknown> | undefined;
      const fetchEndpoint = vi.fn(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          id?: string;
          method: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        if (request.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "GOAT", version: "fixture" },
            },
          });
        if (request.method === "notifications/initialized")
          return new Response(null, { status: 202 });
        if (request.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              tools: ["goat_project_list", "goat_thread_launch"].map((name) => ({ name })),
            },
          });
        const content =
          request.params?.name === "goat_project_list"
            ? {
                projects: [{ id: "project", workspaceRoot: "/projects/fixture" }],
                nextCursor: null,
              }
            : (() => {
                sent = request.params?.arguments;
                return {
                  threadId: "remote",
                  runId: "run-a",
                  ...(echo === "missing"
                    ? {}
                    : {
                        report: {
                          correlationId: echo === "matching" ? binding.correlationId : "another",
                        },
                      }),
                };
              })();
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { structuredContent: content },
        });
      });
      const manager = SshTunnel.SshEnvironmentManager.of({
        status: () => Effect.die("Unexpected runtime status"),
        ensureEnvironment: () =>
          Effect.succeed({
            target,
            httpBaseUrl: "http://projects/fixture.invalid/",
            wsBaseUrl: "ws://projects/fixture.invalid/",
            pairingToken: null,
          }),
        readyEnvironment: () => Effect.die("Unexpected ready environment"),
        beginSetupOperation: () => Effect.die("Unexpected setup operation"),
        publishSetupOutcome: () => Effect.succeed(true),
        publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
        forgetEnvironment: () => Effect.die("Unexpected forget"),
        disconnectEnvironment: () => Effect.void,
        revalidateTunnels: () => Effect.void,
        issueClientSession: () => Effect.die("unused"),
        issueMcpClientSession: () =>
          Effect.succeed({ token: "fixture", expiresAt: null, runtimeModeCeilingApplied: true }),
        runRemoteScript: () =>
          Effect.succeed({
            stdout:
              "T3B\t1\nHOME\t/home/projects/fixture\nOS\tLinux\nPATH\t/projects/fixture\nREAL\t/projects/fixture\n",
            stderr: "",
          }),
      });
      const hosts = vi
        .spyOn(SshConfig, "discoverSshHosts")
        .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
      const managerLayer = vi
        .spyOn(SshTunnel.SshEnvironmentManager, "layer")
        .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
      vi.stubGlobal("fetch", fetchEndpoint);
      try {
        const result = yield* Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.launchThread(
            {
              host,
              cwd: "/projects/fixture",
              title: "fixture",
              workspace: { type: "cwd" },
              runtimeMode: "approval-required",
              callerRuntimeMode: "approval-required",
              report: binding,
            },
            Effect.void,
          );
        }).pipe(
          Effect.provide(
            SshRemoteDispatch.layer.pipe(
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(
                ServerConfig.layerTest("/projects/fixture", { prefix: "report-echo-test-" }),
              ),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        expect(sent?.report).toEqual(binding);
        expect(result.reportsSupported).toBe(echo === "matching");
        expect(result.runId).toBe("run-a");
      } finally {
        vi.unstubAllGlobals();
        managerLayer.mockRestore();
        hosts.mockRestore();
      }
    }),
);

// In-file fixture; deliberately serial because the existing harness stubs global fetch.
describe("SshRemoteDispatch SSH attachments", () => {
  type Attachment = ChatFileAttachment | ChatImageAttachment;
  const originId = (n: number, ext: string) =>
    `pending-00000000-0000-4000-8000-${String(n).padStart(12, "0")}-${ext}`;
  const remoteId = (n: number, ext: string) =>
    `pending-10000000-0000-4000-8000-${String(n).padStart(12, "0")}-${ext}`;
  const inputs: Attachment[] = [
    {
      type: "file",
      id: originId(1, "bin"),
      name: "payload.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 5,
    },
    {
      type: "image",
      id: originId(2, "png"),
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 4,
    },
  ];
  const binaries = [new Uint8Array([0, 255, 128, 13, 10]), new Uint8Array([137, 0, 254, 127])];
  const metadata = (a: Attachment) => ({
    type: a.type,
    name: a.name,
    mimeType: a.mimeType.toLowerCase(),
    sizeBytes: a.sizeBytes,
  });
  const refs = (as: ReadonlyArray<Attachment>) =>
    as.map((a, i) => ({
      ...metadata(a),
      id: remoteId(i + 1, a.type === "image" ? "png" : "bin"),
    }));
  const binding = {
    correlationId: "attachment-correlation",
    originLabel: "fixture",
    originThreadId: ThreadId.make("origin"),
    readKeyHash: "a".repeat(64),
  };
  const project = "goat_project_list";
  const prepare = "goat_attachment_prepare_upload";
  const discard = "goat_attachment_discard";
  const launchTool = "goat_thread_launch";
  type Options = {
    sources?: ReadonlyArray<Attachment>;
    bytes?: ReadonlyArray<Uint8Array>;
    missingProject?: boolean;
    ceilingApplied?: boolean;
    sourceFault?:
      | "missing"
      | "wrong metadata extension"
      | "stat failure"
      | "directory"
      | "stored-size mismatch";
    streamFailure?: boolean;
    prepareEncoding?: "structuredContent" | "JSON text";
    missingPrepare?: boolean;
    prepareRefusal?: boolean;
    preparePatch?: Readonly<Record<string, unknown>>;
    uploadStatus?: number;
    uploadThrows?: boolean;
    receiverLengthDelta?: number;
    launchFailure?: "structured refusal" | "lost HTTP response" | "response missing threadId";
    discardFailure?: "refusal" | "transport failure" | "timeout";
    expiresIn?: number;
    blockPrepare?: number;
    blockUpload?: number;
    blockInitialize?: number;
    onPrepared?: (n: number) => void;
    onUploaded?: (n: number) => void;
    onProject?: () => void;
  };
  const withAttachments = <A, E>(
    options: Options,
    body: (f: {
      sources: ReadonlyArray<Attachment>;
      record: {
        events: string[];
        tools: Array<{
          name: string;
          arguments: Record<string, unknown>;
          authorization: string | null;
        }>;
        uploads: Array<{
          index: number;
          bytes: Uint8Array;
          authorization: string | null;
          status: number;
        }>;
        browse: number;
        bootstrap: number;
        sessions: number;
      };
      started: Deferred.Deferred<void>;
      release: Deferred.Deferred<void>;
      run: <E1 = never, R1 = never>(
        patch?: Partial<SshRemoteDispatch.SshLaunchInput>,
        check?: Effect.Effect<void, E1, R1>,
      ) => Effect.Effect<
        SshRemoteDispatch.SshLaunchResult,
        SshRemoteDispatch.SshRemoteDispatchError | E1,
        R1
      >;
      assertTrace: (events: ReadonlyArray<string>) => void;
    }) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const now = yield* Clock.currentTimeMillis;
        const sources = options.sources ?? inputs;
        const bytes = options.bytes ?? binaries;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const never = yield* Deferred.make<void>();
        const record = {
          events: [] as string[],
          tools: [] as Array<{
            name: string;
            arguments: Record<string, unknown>;
            authorization: string | null;
          }>,
          uploads: [] as Array<{
            index: number;
            bytes: Uint8Array;
            authorization: string | null;
            status: number;
          }>,
          browse: 0,
          bootstrap: 0,
          sessions: 0,
        };
        const paths: string[] = [];
        for (const [i, attachment] of sources.entries()) {
          const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
          if (path === null) throw new Error("Fixture path must resolve");
          paths.push(path);
          yield* fs.writeFile(path, bytes[i]!);
        }
        if (options.sourceFault === "missing") yield* fs.remove(paths[0]!);
        if (options.sourceFault === "directory") {
          yield* fs.remove(paths[0]!);
          yield* fs.makeDirectory(paths[0]!);
        }
        if (options.sourceFault === "stored-size mismatch")
          yield* fs.writeFile(paths[0]!, new Uint8Array([7]));
        // Snapshot the resulting sandbox files, so intentional fixture damage is not called rollback.
        const snapshots = yield* Effect.forEach(paths, (path) =>
          Effect.gen(function* () {
            if (!(yield* fs.exists(path))) return { path, bytes: null };
            const stat = yield* fs.stat(path);
            return { path, bytes: stat.type === "File" ? yield* fs.readFile(path) : null };
          }),
        );
        const testFs = FileSystem.FileSystem.of({
          ...fs,
          stat: (path) =>
            options.sourceFault === "stat failure" && path === paths[0]
              ? fs.stat(`${config.attachmentsDir}/absent-stat-fixture`)
              : fs.stat(path),
          stream: (path, settings) =>
            options.streamFailure && path === paths[1]
              ? Stream.unwrap(
                  fs
                    .stat(`${config.attachmentsDir}/absent-stream-fixture`)
                    .pipe(Effect.map(() => fs.stream(path, settings))),
                )
              : fs.stream(path, settings),
        });
        const expectedByRoute = new Map<string, { index: number; bytes: Uint8Array }>();
        let prepares = 0;
        let initializes = 0;
        let uploadStarts = 0;
        const releaseFetch = Promise.withResolvers<void>();
        yield* Deferred.await(release).pipe(
          Effect.andThen(Effect.sync(() => releaseFetch.resolve())),
          Effect.forkScoped,
        );
        // The fetch mock is a Promise boundary. Signal its milestone without starting a runtime;
        // blocked requests settle only on the fixture release or the bridge's AbortSignal.
        const waitFetch = (init?: RequestInit, waitForRelease = false) => {
          Deferred.doneUnsafe(started, Effect.void);
          return new Promise<void>((resolve, reject) => {
            const signal = init?.signal;
            const abort = () => reject(new DOMException("Fixture request aborted", "AbortError"));
            if (signal?.aborted) return abort();
            signal?.addEventListener("abort", abort, { once: true });
            if (waitForRelease)
              void releaseFetch.promise.then(() => {
                signal?.removeEventListener("abort", abort);
                resolve();
              });
          });
        };
        const fetchEndpoint = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          const parsed = new URL(String(url));
          if (parsed.pathname.startsWith("/api/attachments/upload/")) {
            expect(init?.method).toBe("POST");
            const expected = expectedByRoute.get(parsed.pathname);
            if (expected === undefined) throw new Error("Upload without a prepared token");
            const data = new Uint8Array(await new Response(init?.body).arrayBuffer());
            const status =
              options.uploadStatus !== undefined && expected.index === 2
                ? options.uploadStatus
                : data.length ===
                    expected.bytes.length +
                      (expected.index === 2 ? (options.receiverLengthDelta ?? 0) : 0)
                  ? 204
                  : 400;
            record.events.push(`post:${expected.index}`);
            record.uploads.push({
              index: expected.index,
              bytes: data,
              authorization: new Headers(init?.headers).get("authorization"),
              status,
            });
            if (options.uploadThrows && expected.index === 2)
              throw new TypeError("fixture broken fetch");
            options.onUploaded?.(expected.index);
            return new Response(null, { status });
          }
          expect(parsed.pathname).toBe("/mcp");
          const request = JSON.parse(String(init?.body)) as {
            id?: string;
            method: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          };
          const rpc = (result: unknown) =>
            Response.json({ jsonrpc: "2.0", id: request.id, result });
          if (request.method === "initialize") {
            initializes += 1;
            if (initializes === options.blockInitialize) await waitFetch(init, true);
            return rpc({
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "GOAT", version: "test" },
            });
          }
          if (request.method === "notifications/initialized")
            return new Response(null, { status: 202 });
          if (request.method === "tools/list")
            return rpc({
              tools: [project, prepare, discard, launchTool].map((name) => ({ name })),
            });
          if (request.method !== "tools/call")
            throw new Error(`Unexpected method ${request.method}`);
          const name = request.params?.name ?? "";
          const args = request.params?.arguments ?? {};
          record.tools.push({
            name,
            arguments: args,
            authorization: new Headers(init?.headers).get("authorization"),
          });
          if (name === project) {
            record.events.push("project_list");
            options.onProject?.();
            return rpc({
              structuredContent: {
                projects: options.missingProject
                  ? []
                  : [{ id: "project-1", workspaceRoot: "/home/agent/repo" }],
                nextCursor: null,
              },
            });
          }
          if (name === "goat_project_create") {
            record.events.push("project_create");
            return rpc({ structuredContent: { id: "created-project" } });
          }
          if (name === prepare) {
            const n = ++prepares;
            record.events.push(`prepare:${n}`);
            if (n === options.blockPrepare) await waitFetch(init);
            if (options.missingPrepare)
              return Response.json({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32602, message: `Unknown tool: ${prepare}` },
              });
            if (options.prepareRefusal)
              return rpc({
                isError: true,
                structuredContent: { message: "fixture prepare denied" },
              });
            const attachment = sources[n - 1]!;
            const relativeUrl = `/api/attachments/upload/token-${n}`;
            expectedByRoute.set(relativeUrl, { index: n, bytes: bytes[n - 1]! });
            const value = {
              attachmentId: remoteId(n, attachment.type === "image" ? "png" : "bin"),
              relativeUrl,
              expiresAt: now + (options.expiresIn ?? 600_000),
              ...options.preparePatch,
            };
            options.onPrepared?.(n);
            return options.prepareEncoding === "JSON text"
              ? rpc({ content: [{ type: "text", text: JSON.stringify(value) }] })
              : rpc({ structuredContent: value });
          }
          if (name === discard) {
            const n = refs(sources).findIndex((a) => a.id === args.attachmentId) + 1;
            record.events.push(`discard:${n}`);
            if (n === 1 && options.discardFailure === "timeout") await waitFetch(init);
            if (n === 1 && options.discardFailure === "transport failure")
              throw new TypeError("discard failed");
            return rpc(
              n === 1 && options.discardFailure === "refusal"
                ? { isError: true, structuredContent: { message: "discard denied" } }
                : { structuredContent: { discarded: true } },
            );
          }
          if (name === launchTool) {
            record.events.push("launch");
            if (options.launchFailure === "lost HTTP response")
              throw new TypeError("launch response lost");
            if (options.launchFailure === "structured refusal")
              return rpc({
                isError: true,
                structuredContent: { message: "fixture launch denied" },
              });
            return rpc({
              structuredContent:
                options.launchFailure === "response missing threadId"
                  ? {}
                  : {
                      threadId: "remote-thread",
                      runId: "remote-run",
                      report: { correlationId: binding.correlationId },
                    },
            });
          }
          throw new Error(`Unexpected tool ${name}`);
        });
        const host = "build-box";
        const target = { alias: host, hostname: host, username: null, port: null };
        const manager = SshTunnel.SshEnvironmentManager.of({
          status: () => Effect.die("Unexpected runtime status"),
          ensureEnvironment: () =>
            Effect.sync(() => {
              record.bootstrap += 1;
              return {
                target,
                httpBaseUrl: "http://127.0.0.1:41000/",
                wsBaseUrl: "ws://127.0.0.1:41000/",
                pairingToken: null,
              };
            }),
          readyEnvironment: () => Effect.die("Unexpected ready environment"),
          beginSetupOperation: () => Effect.die("Unexpected setup operation"),
          publishSetupOutcome: () => Effect.succeed(true),
          publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
          forgetEnvironment: () => Effect.die("Unexpected forget"),
          disconnectEnvironment: () => Effect.die("Unexpected disconnect"),
          revalidateTunnels: () => Effect.void,
          issueClientSession: () => Effect.die("unused"),
          issueMcpClientSession: () =>
            Effect.sync(() => {
              record.sessions += 1;
              return {
                token: "attachment-session",
                expiresAt: null,
                runtimeModeCeilingApplied: options.ceilingApplied ?? true,
              };
            }),
          runRemoteScript: () =>
            Effect.sync(() => {
              record.browse += 1;
              return {
                stderr: "",
                stdout:
                  "T3B\t1\nHOME\t/home/agent\nOS\tLinux\nPATH\t/home/agent/repo\nREAL\t/home/agent/repo\n" +
                  "GITROOT\t/home/agent/repo\nBRANCH\tmain\nWT\tworktree /home/agent/repo\n" +
                  "WT\tbranch refs/heads/main\nWT\t\nWT\tworktree /home/agent/wt\nWT\tbranch refs/heads/feature\n",
              };
            }),
        });
        const discover = vi
          .spyOn(SshConfig, "discoverSshHosts")
          .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
        const managerLayer = vi
          .spyOn(SshTunnel.SshEnvironmentManager, "layer")
          .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
        vi.stubGlobal("fetch", fetchEndpoint);
        const http = yield* HttpClient.HttpClient.pipe(
          Effect.provide(
            FetchHttpClient.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchEndpoint)),
            ),
          ),
        );
        const uploadHttp = HttpClient.transform(http, (effect, request) => {
          if (!new URL(request.url).pathname.startsWith("/api/attachments/upload/")) return effect;
          const n = ++uploadStarts;
          if (n !== options.blockUpload) return effect;
          return Effect.sync(() => record.events.push(`blocked:${n}`)).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(never)),
            Effect.andThen(effect),
          );
        });
        try {
          const value = yield* Effect.gen(function* () {
            const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
            const run = <E1 = never, R1 = never>(
              patch: Partial<Omit<SshRemoteDispatch.SshLaunchInput, "host" | "target">> = {},
              check: Effect.Effect<void, E1, R1> = Effect.void,
            ) =>
              dispatch.launchThread(
                {
                  host,
                  cwd: "/home/agent/repo",
                  workspace: { type: "cwd" },
                  title: "Attachments",
                  message: "Inspect",
                  runtimeMode: "full-access",
                  callerRuntimeMode: "full-access",
                  report: binding,
                  attachments: sources,
                  ...patch,
                },
                check,
              );
            const assertTrace = (events: ReadonlyArray<string>) => {
              expect(record.events).toEqual(events);
              expect(record.tools.map((c) => c.name)).toEqual(
                events.flatMap((event) =>
                  event === "project_list"
                    ? [project]
                    : event === "project_create"
                      ? ["goat_project_create"]
                      : event.startsWith("prepare:")
                        ? [prepare]
                        : event.startsWith("discard:")
                          ? [discard]
                          : event === "launch"
                            ? [launchTool]
                            : [],
                ),
              );
              expect(record.uploads.map((u) => u.index)).toEqual(
                events.filter((e) => e.startsWith("post:")).map((e) => Number(e.split(":")[1])),
              );
              for (const upload of record.uploads) {
                expect(
                  Buffer.from(upload.bytes).equals(Buffer.from(bytes[upload.index - 1]!)),
                ).toBe(true);
                expect(upload.authorization).toBeNull();
              }
              for (const [i, call] of record.tools.filter((c) => c.name === prepare).entries())
                expect(call.arguments).toEqual({ upload: metadata(sources[i]!) });
              for (const call of record.tools)
                expect(call.authorization).toBe("Bearer attachment-session");
              expect(record.sessions).toBe(record.bootstrap === 0 ? 0 : 1);
              const discarded = record.tools
                .filter((c) => c.name === discard)
                .map((c) => c.arguments.attachmentId);
              expect(discarded).toEqual(
                events
                  .filter((e) => e.startsWith("discard:"))
                  .map((e) => refs(sources)[Number(e.split(":")[1]) - 1]!.id),
              );
              expect(discarded.some((id) => sources.some((a) => a.id === id))).toBe(false);
            };
            return yield* body({ sources, record, started, release, run, assertTrace });
          }).pipe(
            Effect.provide(
              SshRemoteDispatch.layer.pipe(
                Layer.provide(ServerSettings.layerTest()),
                Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
                Layer.provide(Layer.succeed(FileSystem.FileSystem, testFs)),
                Layer.provide(Layer.succeed(HttpClient.HttpClient, uploadHttp)),
                Layer.provide(NodeServices.layer),
              ),
            ),
          );
          for (const snapshot of snapshots)
            if (snapshot.bytes !== null)
              expect(
                Buffer.from(yield* fs.readFile(snapshot.path)).equals(Buffer.from(snapshot.bytes)),
              ).toBe(true);
          return value;
        } finally {
          vi.unstubAllGlobals();
          managerLayer.mockRestore();
          discover.mockRestore();
        }
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest("/fixture", { prefix: "ssh-attachments-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

  const failure = (reason: SshRemoteDispatch.SshRemoteDispatchError["reason"], message?: string) =>
    Effect.fn(function* (
      run: Effect.Effect<
        SshRemoteDispatch.SshLaunchResult,
        SshRemoteDispatch.SshRemoteDispatchError
      >,
    ) {
      const result = yield* run.pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("Expected failure");
      expect(result.failure.reason).toBe(reason);
      if (message !== undefined) expect(result.failure.message).toContain(message);
      return result.failure;
    });
  const complete = ["project_list", "prepare:1", "post:1", "prepare:2", "post:2", "launch"];
  const rollback = [...complete.slice(0, -1), "discard:1", "discard:2"];
  const callerError = new OrchestratorMcpFailure({
    code: "parent_not_active",
    message: "fixture caller ended",
  });
  const assertCaller = Effect.fn(function* (
    run: Effect.Effect<
      SshRemoteDispatch.SshLaunchResult,
      SshRemoteDispatch.SshRemoteDispatchError | OrchestratorMcpFailure
    >,
  ) {
    const result = yield* run.pipe(Effect.result);
    expect(result._tag === "Failure" && result.failure).toBe(callerError);
  });
  const authority = (live: Ref.Ref<boolean>) =>
    Ref.get(live).pipe(Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(callerError))));

  it.effect.each([undefined, [] as Attachment[]])(
    "launches without upload calls for attachments %s",
    (attachments) =>
      withAttachments({}, (f) =>
        Effect.gen(function* () {
          const value = yield* f.run({ attachments });
          expect(value.threadId).toBe("remote-thread");
          expect(value).toMatchObject({ reportsSupported: true, runId: "remote-run" });
          f.assertTrace(["project_list", "launch"]);
          expect(f.record.tools.at(-1)?.arguments).not.toHaveProperty("attachments");
        }),
      ),
  );
  it.effect("uploads binary files and images before launching with remote pending ids", () =>
    withAttachments({}, (f) =>
      Effect.gen(function* () {
        const value = yield* f.run();
        expect(value).toMatchObject({
          threadId: "remote-thread",
          reportsSupported: true,
          runId: "remote-run",
        });
        f.assertTrace(complete);
        expect(f.record.uploads.map((u) => u.status)).toEqual([204, 204]);
        expect(f.record.tools.at(-1)?.arguments).toMatchObject({
          projectId: "project-1",
          attachments: refs(inputs),
          report: binding,
        });
      }),
    ),
  );
  it.effect("keeps signed upload capabilities out of traces and launch results", () =>
    withAttachments({}, (f) =>
      Effect.gen(function* () {
        const spans: Tracer.Span[] = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const result = yield* f.run().pipe(Effect.withTracer(tracer));
        f.assertTrace(complete);
        const telemetry = JSON.stringify(
          spans.map((span) => ({
            name: span.name,
            attributes: Object.fromEntries(span.attributes),
          })),
        );
        for (const token of ["token-1", "token-2", "attachment-session"]) {
          expect(telemetry).not.toContain(token);
          expect(JSON.stringify(result)).not.toContain(token);
        }
      }),
    ),
  );
  it.effect.each(["cwd", "worktree", "existing_worktree"] as const)(
    "uploads attachments for workspace %s",
    (type) =>
      withAttachments({}, (f) =>
        Effect.gen(function* () {
          const workspace: SshRemoteDispatch.SshLaunchInput["workspace"] =
            type === "cwd"
              ? { type }
              : type === "worktree"
                ? { type, branch: "feature" }
                : { type, worktreePath: "/home/agent/wt", branch: "feature" };
          const expected =
            type === "cwd"
              ? { type: "root" }
              : type === "worktree"
                ? { type, baseRef: "main", branch: "feature", startFromOrigin: false }
                : { type, worktreePath: "/home/agent/wt", branch: "feature" };
          const value = yield* f.run({ workspace });
          expect(value.workspaceStrategy).toEqual(expected);
          f.assertTrace(complete);
          expect(f.record.tools.at(-1)?.arguments).toMatchObject({
            workspaceStrategy: expected,
            attachments: refs(inputs),
          });
        }),
      ),
  );
  it.effect("uploads only after a missing project has been registered", () =>
    withAttachments({ missingProject: true }, (f) =>
      Effect.gen(function* () {
        const value = yield* f.run();
        expect(value.projectCreated).toBe(true);
        f.assertTrace(["project_list", "project_create", ...complete.slice(1)]);
        expect(f.record.tools.at(-1)?.arguments.projectId).toBe("created-project");
      }),
    ),
  );
  const invalid = [
    [
      "count-nine",
      Array.from({ length: 9 }, (_, n) => ({ ...inputs[0]!, id: originId(n + 1, "bin") })),
    ],
    ["duplicate-id", [inputs[0], inputs[0]]],
    ["non-pending", [{ ...inputs[0], id: originId(1, "bin").replace("pending-", "caller-") }]],
    ["malformed-id", [{ ...inputs[0], id: "../payload" }]],
    ["unsupported-type", [{ ...inputs[0], type: "audio" }]],
  ] as const;
  it.effect.each(invalid.map(([name, attachments]) => ({ name, attachments })))(
    "rejects direct attachment input $name before SSH",
    ({ attachments }) =>
      withAttachments({}, (f) =>
        Effect.gen(function* () {
          yield* failure("invalid_request")(
            f.run({ attachments: attachments as unknown as Attachment[] }),
          );
          f.assertTrace([]);
          expect([f.record.browse, f.record.bootstrap]).toEqual([0, 0]);
        }),
      ),
  );
  it.effect.each(
    (
      [
        ["zero-size image", { ...inputs[1]!, sizeBytes: 0 }],
        ["unsupported image MIME", { ...inputs[1]!, mimeType: "image/svg+xml" }],
        ["image >10 MiB", { ...inputs[1]!, sizeBytes: 10 * 1024 * 1024 + 1 }],
        ["file >50 MiB", { ...inputs[0]!, sizeBytes: 50 * 1024 * 1024 + 1 }],
      ] as const
    ).map(([name, attachment]) => ({ name, attachment })),
  )("rejects upload metadata $name before SSH", ({ attachment }) =>
    withAttachments({}, (f) =>
      Effect.gen(function* () {
        yield* failure("invalid_request")(f.run({ attachments: [attachment] }));
        f.assertTrace([]);
        expect([f.record.browse, f.record.bootstrap]).toEqual([0, 0]);
      }),
    ),
  );
  it.effect("rejects aggregate image bytes above eighty MiB before SSH", () =>
    withAttachments({}, (f) =>
      Effect.gen(function* () {
        yield* failure("invalid_request")(
          f.run({
            attachments: [1, 2].map((n) => ({
              ...inputs[0]!,
              id: originId(n, "bin"),
              mimeType: "image/png",
              sizeBytes: 50 * 1024 * 1024,
            })),
          }),
        );
        f.assertTrace([]);
        expect([f.record.browse, f.record.bootstrap]).toEqual([0, 0]);
      }),
    ),
  );
  it.effect("accepts image and file size boundaries", () => {
    const sources = [
      { ...inputs[0]!, sizeBytes: 50 * 1024 * 1024 },
      { ...inputs[1]!, sizeBytes: 10 * 1024 * 1024 },
    ];
    const bytes = sources.map((a) => new Uint8Array(a.sizeBytes).fill(171));
    return withAttachments({ sources, bytes }, (f) =>
      Effect.gen(function* () {
        yield* f.run();
        f.assertTrace(complete);
        expect(f.record.uploads.map((u) => [u.bytes.length, u.status])).toEqual([
          [50 * 1024 * 1024, 204],
          [10 * 1024 * 1024, 204],
        ]);
        expect(f.record.tools.at(-1)?.arguments.attachments).toEqual(refs(sources));
      }),
    );
  });
  it.effect.each([
    "missing",
    "wrong metadata extension",
    "stat failure",
    "directory",
    "stored-size mismatch",
  ] as const)("rejects pending source %s before prepare", (sourceFault) =>
    withAttachments({ sourceFault, missingProject: true }, (f) =>
      Effect.gen(function* () {
        const attachments =
          sourceFault === "wrong metadata extension"
            ? [{ ...inputs[0]!, name: "payload.txt" }, inputs[1]!]
            : inputs;
        yield* failure("invalid_request")(f.run({ attachments }));
        f.assertTrace([]);
        expect([f.record.browse, f.record.bootstrap]).toEqual([0, 0]);
      }),
    ),
  );
  it.effect("refuses attachment writes when the remote cannot apply the caller ceiling", () =>
    withAttachments({ ceilingApplied: false }, (f) =>
      Effect.gen(function* () {
        yield* failure(
          "remote_refused",
          "ceiling",
        )(f.run({ runtimeMode: "approval-required" as const }));
        f.assertTrace([]);
      }),
    ).pipe(
      Effect.andThen(
        withAttachments({ ceilingApplied: false }, (f) =>
          Effect.gen(function* () {
            yield* f.run({ runtimeMode: "approval-required", attachments: [] });
            f.assertTrace(["project_list", "launch"]);
          }),
        ),
      ),
    ),
  );
  it.effect("refuses old remotes missing goat_attachment_prepare_upload", () =>
    withAttachments({ missingPrepare: true }, (f) =>
      Effect.gen(function* () {
        yield* failure("remote_refused", "goat_attachment_prepare_upload")(f.run());
        f.assertTrace(["project_list", "prepare:1"]);
      }),
    ),
  );
  it.effect("keeps structured preparation refusals", () =>
    withAttachments({ prepareRefusal: true }, (f) =>
      Effect.gen(function* () {
        yield* failure("remote_refused", "fixture prepare denied")(f.run());
        f.assertTrace(["project_list", "prepare:1"]);
      }),
    ),
  );
  it.effect.each(["structuredContent", "JSON text"] as const)(
    "accepts preparation results encoded as %s",
    (prepareEncoding) =>
      withAttachments({ prepareEncoding }, (f) =>
        Effect.gen(function* () {
          yield* f.run();
          f.assertTrace(complete);
          expect(f.record.tools.at(-1)?.arguments.attachments).toEqual(refs(inputs));
        }),
      ),
  );
  it.effect.each(
    (
      [
        ["absent id", { attachmentId: null }, false],
        ["malformed id", { attachmentId: "../bad" }, false],
        [
          "non-pending id",
          { attachmentId: remoteId(1, "bin").replace("pending-", "claimed-") },
          false,
        ],
        ["missing URL", { relativeUrl: null }, true],
        ["malformed expiry", { expiresAt: "later" }, true],
      ] as const
    ).map(([name, preparePatch, known]) => ({ name, preparePatch, known })),
  )("rejects preparation result $name", ({ preparePatch, known }) =>
    withAttachments({ preparePatch }, (f) =>
      Effect.gen(function* () {
        yield* failure("remote_refused")(f.run());
        f.assertTrace(["project_list", "prepare:1", ...(known ? ["discard:1"] : [])]);
      }),
    ),
  );
  it.effect.each(
    (
      [
        ["malformed URL", { relativeUrl: "http://[" }],
        ["foreign origin", { relativeUrl: "https://foreign.invalid/api/attachments/upload/token" }],
        [
          "protocol-relative URL",
          { relativeUrl: "//foreign.invalid/api/attachments/upload/token" },
        ],
        ["wrong route", { relativeUrl: "/api/wrong/token" }],
        [
          "normalized path escaping route",
          { relativeUrl: "/api/attachments/upload/../../../wrong" },
        ],
        ["already expired", { expiresAt: 0 }],
        ["non-finite expiry", { expiresAt: Infinity }],
      ] as const
    ).map(([name, preparePatch]) => ({ name, preparePatch })),
  )("rejects upload URL $name and discards its prepared id", ({ preparePatch }) =>
    withAttachments({ preparePatch }, (f) =>
      Effect.gen(function* () {
        yield* failure("remote_refused")(f.run());
        f.assertTrace(["project_list", "prepare:1", "discard:1"]);
      }),
    ),
  );
  it.effect("times out attachment preparation without launching", () =>
    withAttachments({ blockPrepare: 2 }, (f) =>
      Effect.gen(function* () {
        const fiber = yield* f.run().pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(f.started);
        yield* TestClock.adjust(20_001);
        const result = yield* Fiber.join(fiber);
        expect(result._tag === "Failure" && result.failure.reason).toBe("host_unavailable");
        f.assertTrace(["project_list", "prepare:1", "post:1", "prepare:2", "discard:1"]);
      }),
    ),
  );
  it.effect.each([-1, 1])(
    "rejects receiver byte-count mismatch %s and discards both ids",
    (receiverLengthDelta) =>
      withAttachments({ receiverLengthDelta }, (f) =>
        Effect.gen(function* () {
          yield* failure("remote_refused", "HTTP 400; expected 204")(f.run());
          f.assertTrace(rollback);
          expect(f.record.uploads.map((u) => u.status)).toEqual([204, 400]);
        }),
      ),
  );
  it.effect.each([200, 400, 404, 500])(
    "fails upload HTTP %s and discards all prepared ids",
    (uploadStatus) =>
      withAttachments({ uploadStatus }, (f) =>
        Effect.gen(function* () {
          yield* failure("remote_refused", "expected 204")(f.run());
          f.assertTrace(rollback);
        }),
      ),
  );
  it.effect.each(["stream", "fetch"] as const)(
    "fails a broken upload stream and retains local sources (%s)",
    (fault) =>
      withAttachments({ streamFailure: fault === "stream", uploadThrows: fault === "fetch" }, (f) =>
        Effect.gen(function* () {
          yield* failure("host_unavailable")(f.run());
          f.assertTrace(
            fault === "stream"
              ? ["project_list", "prepare:1", "post:1", "prepare:2", "discard:1", "discard:2"]
              : rollback,
          );
        }),
      ),
  );
  it.effect.each(
    (
      [
        ["60 s cap", 600_000, 60_001],
        ["signed URL lifetime", 2_000, 2_001],
      ] as const
    ).map(([name, expiresIn, advance]) => ({ name, expiresIn, advance })),
  )("times out the byte upload at the smaller deadline ($name)", ({ expiresIn, advance }) =>
    withAttachments({ blockUpload: 2, expiresIn }, (f) =>
      Effect.gen(function* () {
        const fiber = yield* f.run().pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(f.started);
        yield* TestClock.adjust(advance);
        const result = yield* Fiber.join(fiber);
        expect(result._tag === "Failure" && result.failure.reason).toBe("host_unavailable");
        f.assertTrace([
          "project_list",
          "prepare:1",
          "post:1",
          "prepare:2",
          "blocked:2",
          "discard:1",
          "discard:2",
        ]);
      }),
    ),
  );
  it.effect("sends no prepare after the caller check fails", () =>
    Effect.gen(function* () {
      let live = true;
      yield* withAttachments(
        {
          onProject: () => {
            live = false;
          },
        },
        (f) =>
          Effect.gen(function* () {
            yield* assertCaller(
              f.run(
                {},
                Effect.suspend(() => (live ? Effect.void : Effect.fail(callerError))),
              ),
            );
            f.assertTrace(["project_list"]);
          }),
      );
    }),
  );
  it.effect.each(
    (
      [
        ["sends no prepare after authority drops during initialize", 2, ["project_list"]],
        ["does not launch after authority drops during final initialize", 5, rollback],
      ] as const
    ).map(([name, blockInitialize, expected]) => ({ name, blockInitialize, expected })),
  )("$name", ({ blockInitialize, expected }) =>
    Effect.gen(function* () {
      const live = yield* Ref.make(true);
      yield* withAttachments({ blockInitialize }, (f) =>
        Effect.gen(function* () {
          const fiber = yield* f.run({}, authority(live)).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(f.started);
          yield* Ref.set(live, false);
          yield* Deferred.succeed(f.release, undefined);
          const result = yield* Fiber.join(fiber);
          expect(result._tag === "Failure" && result.failure).toBe(callerError);
          f.assertTrace(expected);
        }),
      );
    }),
  );
  it.effect.each(
    (
      [
        [
          "discards preparation when authority drops before the byte POST",
          "prepare",
          1,
          ["project_list", "prepare:1", "discard:1"],
        ],
        [
          "does not prepare later files after authority drops",
          "upload",
          1,
          ["project_list", "prepare:1", "post:1", "discard:1"],
        ],
        ["does not launch after authority drops during the last upload", "upload", 2, rollback],
      ] as const
    ).map(([name, at, index, expected]) => ({ name, at, index, expected })),
  )("$name", ({ at, index, expected }) =>
    Effect.gen(function* () {
      let live = true;
      const drop = (n: number) => {
        if (n === index) live = false;
      };
      yield* withAttachments(at === "prepare" ? { onPrepared: drop } : { onUploaded: drop }, (f) =>
        Effect.gen(function* () {
          yield* assertCaller(
            f.run(
              {},
              Effect.suspend(() => (live ? Effect.void : Effect.fail(callerError))),
            ),
          );
          f.assertTrace(expected);
        }),
      );
    }),
  );
  it.effect.each([
    "structured refusal",
    "lost HTTP response",
    "response missing threadId",
  ] as const)("discards pending uploads after remote launch %s", (launchFailure) =>
    withAttachments({ launchFailure }, (f) =>
      Effect.gen(function* () {
        const result = yield* f.run().pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") throw new Error("Expected failure");
        expect(result.failure.message).toContain(
          launchFailure === "structured refusal"
            ? "fixture launch denied"
            : launchFailure === "response missing threadId"
              ? "no thread acknowledgement"
              : "Calling goat_thread_launch",
        );
        f.assertTrace([...complete, "discard:1", "discard:2"]);
        expect(f.record.tools.filter((c) => c.name === launchTool)).toHaveLength(1);
      }),
    ),
  );
  it.effect.each(["refusal", "transport failure", "timeout"] as const)(
    "continues rollback after discard %s",
    (discardFailure) =>
      withAttachments({ discardFailure, uploadStatus: 500 }, (f) =>
        Effect.gen(function* () {
          const fiber = yield* f.run().pipe(Effect.result, Effect.forkChild);
          if (discardFailure === "timeout") {
            yield* Deferred.await(f.started);
            yield* TestClock.adjust(5_001);
          }
          const result = yield* Fiber.join(fiber);
          expect(result._tag === "Failure" && result.failure.reason).toBe("remote_refused");
          expect(result._tag === "Failure" && result.failure.message).toContain(
            "HTTP 500; expected 204",
          );
          f.assertTrace(rollback);
        }),
      ),
  );
  it.effect("rolls back known pending ids when the launch fiber is interrupted", () =>
    withAttachments({ blockUpload: 1 }, (f) =>
      Effect.gen(function* () {
        const fiber = yield* f.run().pipe(Effect.forkChild);
        yield* Deferred.await(f.started);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
        f.assertTrace(["project_list", "prepare:1", "blocked:1", "discard:1"]);
      }),
    ),
  );
});

describe("SSH launcher transport", () => {
  it.effect.each([
    { name: "current", refusal: null, launchedBy: true, expectedCalls: 1, success: true },
    { name: "threadless", refusal: null, launchedBy: false, expectedCalls: 1, success: true },
    {
      name: "strict-old",
      refusal: "goat_thread_launch does not take launchedBy, so nothing ran",
      launchedBy: true,
      expectedCalls: 2,
      success: true,
    },
    {
      name: "handler-refusal",
      refusal: "goat_thread_launch cannot run this model",
      launchedBy: true,
      expectedCalls: 1,
      success: false,
    },
    {
      name: "ambiguous",
      refusal: "connection closed after creating thread",
      launchedBy: true,
      expectedCalls: 1,
      success: false,
    },
    {
      name: "retry-refused",
      refusal: "goat_thread_launch does not take launchedBy, so nothing ran",
      launchedBy: true,
      expectedCalls: 2,
      success: false,
    },
  ])("passes launcher and retries only a strict pre-handler refusal: $name", (scenario) =>
    Effect.gen(function* () {
      const target = { alias: "box", hostname: "box", username: null, port: null };
      const calls: Array<Record<string, unknown>> = [];
      let creates = 0;
      let authorizations = 0;
      const authAtCalls: number[] = [];
      const launcher = {
        kind: "launch" as const,
        environmentLabel: null,
        threadTitle: null,
        via: "ssh_thread_launch" as const,
        threadId: ThreadId.make("origin-thread"),
        environmentId: EnvironmentId.make("origin-env"),
      };
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      const fetchEndpoint = vi.fn(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          id: string;
          method: string;
          params?: { name: string; arguments: Record<string, unknown> };
        };
        if (request.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "GOAT", version: "test" },
            },
          });
        if (request.method === "notifications/initialized")
          return new Response(null, { status: 202 });
        if (request.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              tools: [
                {
                  name: "goat_thread_launch",
                  inputSchema: { type: "object", properties: { launchedBy: { type: "object" } } },
                },
              ],
            },
          });
        if (request.method === "tools/call") {
          if (request.params?.name === "goat_project_list")
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                structuredContent: {
                  projects: [{ id: "project-1", workspaceRoot: "/home/agent/repo" }],
                  nextCursor: null,
                },
              },
            });
          if (request.params?.name !== "goat_thread_launch") throw new Error("Unexpected tool");
          calls.push(request.params.arguments);
          authAtCalls.push(authorizations);
          if (
            (calls.length === 1 && scenario.refusal !== null) ||
            scenario.name === "retry-refused"
          ) {
            if (scenario.name === "ambiguous") creates += 1;
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32602, message: scenario.refusal },
            });
          }
          creates += 1;
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: { structuredContent: { threadId: "remote-thread" } },
          });
        }
        throw new Error(`Unexpected method ${request.method}`);
      });
      const manager = SshTunnel.SshEnvironmentManager.of({
        status: () => Effect.die("Unexpected runtime status"),
        ensureEnvironment: () =>
          Effect.succeed({
            target,
            httpBaseUrl: "http://box:3773/",
            wsBaseUrl: "ws://box:3773/",
            pairingToken: null,
            remoteServerVersion: "0.0.1-older",
          }),
        readyEnvironment: () => Effect.die("Unexpected ready environment"),
        beginSetupOperation: () => Effect.die("Unexpected setup operation"),
        publishSetupOutcome: () => Effect.succeed(true),
        publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
        forgetEnvironment: () => Effect.die("Unexpected forget"),
        disconnectEnvironment: () => Effect.die("Unexpected disconnect"),
        revalidateTunnels: () => Effect.void,
        issueClientSession: () => Effect.die("unused"),
        issueMcpClientSession: () =>
          Effect.succeed({ token: "fixture", expiresAt: null, runtimeModeCeilingApplied: true }),
        runRemoteScript: () =>
          Effect.succeed({
            stdout:
              "T3B\t1\nHOME\t/home/agent\nOS\tLinux\nPATH\t/home/agent/repo\nREAL\t/home/agent/repo\n",
            stderr: "",
          }),
      });
      const discover = vi
        .spyOn(SshConfig, "discoverSshHosts")
        .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
      const managerLayer = vi
        .spyOn(SshTunnel.SshEnvironmentManager, "layer")
        .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
      vi.stubGlobal("fetch", fetchEndpoint);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          vi.unstubAllGlobals();
          managerLayer.mockRestore();
          discover.mockRestore();
        }),
      );
      const result = yield* Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        return yield* dispatch
          .launchThread(
            {
              host: "box",
              cwd: "/home/agent/repo",
              workspace: { type: "cwd" },
              title: "Work",
              message: "Implement",
              modelSelection,
              runtimeMode: "auto",
              callerRuntimeMode: "full-access",
              interactionMode: "default",
              ...(scenario.launchedBy ? { launchedBy: launcher } : {}),
            },
            Effect.sync(() => {
              authorizations += 1;
            }),
          )
          .pipe(Effect.result);
      }).pipe(
        Effect.provide(
          SshRemoteDispatch.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-launcher-test-" })),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      expect(calls).toHaveLength(scenario.expectedCalls);
      expect(result._tag).toBe(scenario.success ? "Success" : "Failure");
      expect(calls[0]).toEqual({
        projectId: "project-1",
        title: "Work",
        workspaceStrategy: { type: "root" },
        runtimeMode: "auto",
        interactionMode: "default",
        modelSelection,
        message: "Implement",
        ...(scenario.launchedBy ? { launchedBy: launcher } : {}),
      });
      if (scenario.expectedCalls === 2) {
        expect(calls[1]).not.toHaveProperty("launchedBy");
        expect(authAtCalls[1]).toBe(authAtCalls[0]! + 1);
        if (result._tag === "Success")
          expect(result.success.notes.join(" ")).toContain(
            'scope:"launched" cannot find its questions',
          );
      }
      if (result._tag === "Success")
        expect(result.success.notes).toContain(
          `GOAT on box runs 0.0.1-older; this machine runs ${packageJson.version}. Both speak the same protocols, but a tool or launch option added in the newer build can be missing on the older one.`,
        );
      expect(creates).toBe(scenario.success || scenario.name === "ambiguous" ? 1 : 0);
    }),
  );
});

it.effect("ready-only host tools never bootstrap or issue a session on a stopped runtime", () =>
  Effect.gen(function* () {
    const host = "ready-only";
    const target = { alias: host, hostname: host, username: null, port: null };
    let ensures = 0;
    let sessions = 0;
    const discover = vi
      .spyOn(SshConfig, "discoverSshHosts")
      .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
    const manager = vi.spyOn(SshTunnel.SshEnvironmentManager, "layer").mockReturnValue(
      Layer.mock(SshTunnel.SshEnvironmentManager)({
        readyEnvironment: () =>
          Effect.fail(new SshLaunchError({ message: "Runtime is stopped", stdout: "" })),
        ensureEnvironment: () => {
          ensures++;
          return Effect.die("must not bootstrap");
        },
        issueClientSession: () => Effect.die("unused"),
        issueMcpClientSession: () => {
          sessions++;
          return Effect.die("must not issue");
        },
      }),
    );
    yield* Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      const failure = yield* dispatch
        .callHostTool(
          {
            host,
            tool: "goat_provider_diagnose",
            arguments: {},
            timeoutMs: 1000,
            writes: false,
            requireReady: true,
          },
          Effect.succeed("approval-required"),
        )
        .pipe(Effect.result);
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") {
        expect(failure.failure.reason).toBe("host_unavailable");
        expect(failure.failure.message).toContain("goat_ssh_host_prepare");
      }
      expect([ensures, sessions]).toEqual([0, 0]);
    }).pipe(
      Effect.provide(
        SshRemoteDispatch.layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "ready-only-" })),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          manager.mockRestore();
          discover.mockRestore();
        }),
      ),
    );
  }),
);

it.effect(
  "automatic placement refuses a new grant without bootstrapping or registering a project",
  () =>
    withLaunchRemote({ existing: true }, (record) =>
      Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        const refused = yield* dispatch
          .launchThread({ ...launchInput, existingSessionOnly: true }, Effect.void)
          .pipe(Effect.flip);
        expect(refused.reason).toBe("host_unavailable");
        expect(record.ensures).toBe(0);
        expect(record.sessions).toHaveLength(0);
        expect(record.tools).toHaveLength(0);
      }),
    ),
);

it.effect(
  "automatic placement reuses an existing exact grant and never creates a missing project",
  () =>
    withLaunchRemote({ existing: true }, (record) =>
      Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        yield* dispatch.launchThread(launchInput, Effect.void);
        const firstSessions = record.sessions.length;
        const firstEnsures = record.ensures;
        yield* dispatch.launchThread({ ...launchInput, existingSessionOnly: true }, Effect.void);
        expect(record.sessions).toHaveLength(firstSessions);
        expect(record.ensures).toBe(firstEnsures);
        expect(record.readies).toBe(2);
        expect(record.tools.filter((tool) => tool.name === "goat_project_create")).toHaveLength(0);
        const refused = yield* dispatch
          .launchThread(
            { ...launchInput, existingSessionOnly: true, memoryGrantCeiling: "read" },
            Effect.void,
          )
          .pipe(Effect.flip);
        expect(refused.reason).toBe("host_unavailable");
        expect(record.sessions).toHaveLength(firstSessions);
      }),
    ),
);

it.effect("strict launch refuses a rejected cached credential across caller retries", () => {
  let reject = false;
  return withLaunchRemote({ existing: true, rejectSession: () => reject }, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      yield* dispatch.launchThread(launchInput, Effect.void);
      reject = true;
      const refused = yield* dispatch
        .launchThread({ ...launchInput, existingSessionOnly: true }, Effect.void)
        .pipe(Effect.result);
      expect(refused).toMatchObject({ _tag: "Failure", failure: { reason: "remote_refused" } });
      const retried = yield* dispatch
        .launchThread({ ...launchInput, existingSessionOnly: true }, Effect.void)
        .pipe(Effect.result);
      expect(retried).toMatchObject({ _tag: "Failure", failure: { reason: "host_unavailable" } });
      expect(record.sessions).toHaveLength(1);
      expect(record.ensures).toBe(1);
      expect(record.tools.filter((tool) => tool.name === "goat_thread_launch")).toHaveLength(1);
    }),
  );
});

it.effect("strict cached transport checks the current caller before sending an RPC", () => {
  let permitted = true;
  const revoked = new Error("caller revoked");
  return withLaunchRemote({ existing: true, discoverSavedHost: true }, (record) =>
    Effect.gen(function* () {
      const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
      yield* dispatch.launchThread(launchInput, Effect.void);
      const toolsBefore = record.tools.length;
      const authorize = Effect.suspend(() =>
        permitted ? Effect.succeed(launchInput.callerRuntimeMode) : Effect.fail(revoked),
      );
      permitted = false;
      const result = yield* dispatch
        .callHostTool(
          {
            host: savedTarget.alias,
            tool: "goat_thread_read",
            arguments: { threadId: "rt" },
            timeoutMs: 1000,
            writes: false,
            existingSessionOnly: true,
          },
          authorize,
        )
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBe(revoked);
      const launch = yield* dispatch
        .launchThread({ ...launchInput, existingSessionOnly: true }, authorize.pipe(Effect.asVoid))
        .pipe(Effect.result);
      expect(launch._tag).toBe("Failure");
      if (launch._tag === "Failure") expect(launch.failure).toBe(revoked);
      expect(record.tools).toHaveLength(toolsBefore);
      expect(record.sessions).toHaveLength(1);
      expect(record.ensures).toBe(1);
    }),
  );
});

it.effect(
  "a fresh real SSH transport renews only the accepted grant to observe the same worker",
  () =>
    withLaunchRemote(
      { existing: true, discoverSavedHost: true, declaresMemoryCeiling: true },
      (record) =>
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          const accepted = {
            ...launchInput,
            callerRuntimeMode: "auto-accept-edits" as const,
            memoryGrantCeiling: "read" as const,
          };
          yield* dispatch.launchThread(accepted, Effect.void);
          const fresh = yield* Layer.build(
            Layer.fresh(
              SshRemoteDispatch.layer.pipe(
                Layer.provide(ServerSettings.layerTest()),
                Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "placement-restart-" })),
                Layer.provide(FetchHttpClient.layer),
                Layer.provide(NodeServices.layer),
              ),
            ),
          );
          const recovered = Context.get(fresh, SshRemoteDispatch.SshRemoteDispatch);
          const read = {
            host: savedTarget.alias,
            tool: "goat_origin_reports_wait",
            arguments: {
              correlationId: "fixture-binding",
              readKey: "fixture-read-key",
              afterSequence: 0,
              timeoutMs: 0,
              knownRun: null,
              watchRunId: null,
            },
            writes: false,
            timeoutMs: 1000,
            requireReady: true as const,
            memoryGrantCeiling: "read" as const,
          };
          const unavailable = yield* recovered
            .callHostTool(
              { ...read, existingSessionOnly: true },
              Effect.succeed("auto-accept-edits" as const),
            )
            .pipe(Effect.result);
          expect(unavailable._tag).toBe("Failure");
          if (unavailable._tag === "Failure")
            expect(unavailable.failure.reason).toBe("host_unavailable");
          expect(record.sessions).toHaveLength(1);
          const result = yield* recovered.callHostTool(
            read,
            Effect.succeed("auto-accept-edits" as const),
          );
          expect(result).toMatchObject({
            threadId: "rt",
            latestRunId: "run",
            observedRun: { status: "running" },
          });
          expect(record.sessionRequests).toEqual([
            { ceiling: "auto-accept-edits", memoryScopes: ["memory:read"], requireReady: false },
            { ceiling: "auto-accept-edits", memoryScopes: ["memory:read"], requireReady: true },
          ]);
          expect(record.ensures).toBe(1);
          expect(record.tools.filter((tool) => tool.name === "goat_thread_launch")).toHaveLength(1);
          expect(record.tools.filter((tool) => tool.name === "goat_project_create")).toHaveLength(
            0,
          );
        }).pipe(Effect.scoped),
    ),
);

it.effect("a revoked caller cannot renew a ready SSH transport session", () => {
  let permitted = true;
  let checks = 0;
  const revoked = new Error("caller grant revoked");
  return withLaunchRemote(
    {
      existing: true,
      discoverSavedHost: true,
      beforeReady: Effect.sync(() => {
        permitted = false;
      }),
    },
    (record) =>
      Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        const authorize = Effect.suspend(() => {
          checks += 1;
          return permitted ? Effect.succeed("auto-accept-edits" as const) : Effect.fail(revoked);
        });
        const result = yield* dispatch
          .callHostTool(
            {
              host: savedTarget.alias,
              tool: "goat_origin_reports_wait",
              arguments: {},
              writes: false,
              timeoutMs: 1000,
              requireReady: true,
              memoryGrantCeiling: "read",
            },
            authorize,
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure).toBe(revoked);
        expect(checks).toBe(2);
        expect(record.readies).toBe(1);
        expect(record.sessionRequests).toHaveLength(0);
        expect(record.ensures).toBe(0);
        expect(record.tools).toHaveLength(0);
      }),
  );
});
