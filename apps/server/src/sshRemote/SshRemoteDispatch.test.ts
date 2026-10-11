import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import * as SshConfig from "@t3tools/ssh/config";
import { SshCommandError } from "@t3tools/ssh/errors";
import { EnvironmentId, ThreadId, type RuntimeMode } from "@t3tools/contracts";
import * as SshTunnel from "@t3tools/ssh/tunnel";

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";

import * as ServerConfig from "../config.ts";
import { hostFailure } from "../mcp/HostThreadsMcpService.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";
import {
  broadWorkspaceRoot,
  matchRemoteProject,
  readRemoteToolResult,
  resolveSshCliRunner,
} from "./SshRemoteDispatch.ts";

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
        ensureEnvironment: () =>
          Effect.succeed({
            target,
            httpBaseUrl: "http://legacy-host:3773/",
            wsBaseUrl: "ws://legacy-host:3773/",
            pairingToken: null,
          }),
        disconnectEnvironment: () => Effect.die("Unexpected SSH disconnect"),
        revalidateTunnels: () => Effect.void,
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
            T3CODE_RELEASE_BASE_URL: "  https://mirror.example/goat/  ",
          }),
        ),
      );
      const script = buildRemoteT3RunnerScript(runner);
      expect(script).toContain("T3_RELEASE_BASE_URL='https://mirror.example/goat'");
      expect(script).not.toContain("github.com/goat-si/goat/releases/download");
      expect(runner.archiveDirectory).toBe("/fixture/home/runtime/archives");
      expect(runner.keepExistingRunner).toBe(true);
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
              { T3CODE_RELEASE_BASE_URL: value },
              { preserveEmptyStrings: true },
            ),
          ),
        );
        expect("releaseBaseUrl" in runner).toBe(false);
        expect(buildRemoteT3RunnerScript(runner)).toContain(
          "T3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'",
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
            T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR:
              "  /Applications/GOAT.app/Contents/Resources/ssh-runtime/archives  ",
            T3CODE_SSH_RUNTIME_ARCHIVE_DIR: "/fixture/user-cache",
          }),
        ),
      );
      expect(runner.bundledArchiveDirectory).toBe(
        "/Applications/GOAT.app/Contents/Resources/ssh-runtime/archives",
      );
      expect(runner.archiveDirectory).toBe("/fixture/user-cache");
      expect(runner.keepExistingRunner).toBe(true);
    }),
  );
  it.effect.each([undefined, "", "  "])("omits empty bundle %s", (value) =>
    Effect.gen(function* () {
      const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(
            {
              T3CODE_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR: value,
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
  const host = "build-box";
  const target = { alias: host, hostname: host, username: null, port: null };

  type ToolAnswer =
    | { readonly status: number }
    | { readonly result: unknown }
    | { readonly rpcError: string }
    | { readonly throws: string };

  /**
   * Runs body against a dispatch whose SSH manager and remote /mcp are fakes.
   * `answer` decides each HTTP request; the record says what reached the remote.
   */
  const withRemote = <A, E>(
    options: {
      readonly answer: (request: { readonly method: string; readonly tool?: string }) => ToolAnswer;
      readonly ensureFails?: boolean;
      readonly ceilingApplied?: boolean;
    },
    body: Effect.Effect<A, E, SshRemoteDispatch.SshRemoteDispatch>,
  ) =>
    Effect.gen(function* () {
      const record = { toolCalls: [] as string[], sessionsIssued: 0, requests: 0 };
      const fetchEndpoint = vi.fn(async (_url: string, init?: RequestInit) => {
        record.requests += 1;
        const request = JSON.parse(String(init?.body)) as {
          id?: string;
          method: string;
          params?: { name?: string };
        };
        if (request.method === "tools/call") record.toolCalls.push(request.params?.name ?? "");
        const answer = options.answer({
          method: request.method,
          ...(request.params?.name === undefined ? {} : { tool: request.params.name }),
        });
        if ("throws" in answer) throw new TypeError(answer.throws);
        if ("status" in answer) return new Response(null, { status: answer.status });
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if ("rpcError" in answer) {
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32602, message: answer.rpcError },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: request.id, result: answer.result });
      });
      const manager = SshTunnel.SshEnvironmentManager.of({
        ensureEnvironment: () =>
          options.ensureFails === true
            ? Effect.fail(
                new SshCommandError({
                  message: "ssh: connect to host build-box port 22: Operation timed out",
                  command: ["ssh", host],
                  exitCode: 255,
                  stderr: "",
                }),
              )
            : Effect.succeed({
                target,
                httpBaseUrl: "http://127.0.0.1:41000/",
                wsBaseUrl: "ws://127.0.0.1:41000/",
                pairingToken: null,
              }),
        disconnectEnvironment: () => Effect.die("Unexpected SSH disconnect"),
        revalidateTunnels: () => Effect.void,
        issueMcpClientSession: () =>
          Effect.sync(() => {
            record.sessionsIssued += 1;
            return {
              token: `session-${record.sessionsIssued}`,
              expiresAt: null,
              runtimeModeCeilingApplied: options.ceilingApplied ?? true,
            };
          }),
        runRemoteScript: () => Effect.die("Unexpected remote script"),
      });
      const discoverHosts = vi
        .spyOn(SshConfig, "discoverSshHosts")
        .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
      const managerLayer = vi
        .spyOn(SshTunnel.SshEnvironmentManager, "layer")
        .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
      vi.stubGlobal("fetch", fetchEndpoint);
      try {
        const result = yield* body.pipe(
          Effect.result,
          Effect.provide(
            SshRemoteDispatch.layer.pipe(
              Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-host-call-test-" })),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        return { result, record };
      } finally {
        vi.unstubAllGlobals();
        managerLayer.mockRestore();
        discoverHosts.mockRestore();
      }
    });

  const initialize = (request: { readonly method: string }): ToolAnswer | undefined =>
    request.method === "initialize"
      ? {
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "GOAT", version: "test" },
          },
        }
      : request.method === "notifications/initialized"
        ? { result: null }
        : undefined;

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

describe("SSH dispatch launch lineage", () => {
  const launcher = {
    kind: "launch" as const,
    threadId: ThreadId.make("orchestrator"),
    environmentId: EnvironmentId.make("launcher-environment"),
    environmentLabel: "studio",
    threadTitle: "Orchestrator",
  };

  /** Launches against a fake remote and returns the arguments goat_thread_launch received. */
  const launchAgainst = (remote: {
    readonly declaresLaunchedBy: boolean;
    readonly listFails?: boolean;
  }) =>
    Effect.gen(function* () {
      const host = "lineage-host";
      const target = { alias: host, hostname: host, username: null, port: null };
      const launches: Array<Record<string, unknown>> = [];
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
          case "tools/list":
            if (remote.listFails === true) return new Response(null, { status: 500 });
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                tools: [
                  {
                    name: "goat_thread_launch",
                    inputSchema: {
                      type: "object",
                      properties: {
                        title: { type: "string" },
                        ...(remote.declaresLaunchedBy ? { launchedBy: { type: "object" } } : {}),
                      },
                    },
                  },
                ],
              },
            });
          case "tools/call": {
            if (request.params?.name === "goat_thread_launch") {
              launches.push(request.params.arguments ?? {});
            }
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
        ensureEnvironment: () =>
          Effect.succeed({
            target,
            httpBaseUrl: "http://lineage-host:3773/",
            wsBaseUrl: "ws://lineage-host:3773/",
            pairingToken: null,
          }),
        disconnectEnvironment: () => Effect.die("Unexpected SSH disconnect"),
        revalidateTunnels: () => Effect.void,
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
          return yield* dispatch.launchThread(
            {
              host,
              cwd: "/home/agent/repo",
              workspace: { type: "cwd" },
              title: "Lineage probe",
              runtimeMode: "approval-required",
              callerRuntimeMode: "approval-required",
              launchedBy: launcher,
            },
            Effect.void,
          );
        }).pipe(
          Effect.provide(
            SshRemoteDispatch.layer.pipe(
              Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-dispatch-test-" })),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        return { result, launches };
      } finally {
        vi.unstubAllGlobals();
        managerLayer.mockRestore();
        discoverHosts.mockRestore();
      }
    });

  it.effect("forwards the launcher to a remote whose goat_thread_launch declares it", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* launchAgainst({ declaresLaunchedBy: true });
      expect(result.threadId).toBe("new-thread");
      expect(launches).toHaveLength(1);
      expect(launches[0]?.launchedBy).toEqual(launcher);
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
});
