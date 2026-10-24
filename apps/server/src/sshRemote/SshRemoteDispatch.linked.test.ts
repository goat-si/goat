import * as ServerSettings from "../serverSettings.ts";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { RuntimeMode } from "@goat/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as SshConfig from "@goat/ssh/config";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerConfig from "../config.ts";
import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

const LINK: LinkedHosts.LinkedHostCredential = {
  host: {
    name: "box",
    baseUrl: "https://box.example.ts.net",
    environmentId: "env-box",
    label: "Build box",
    serverVersion: "0.1.0-test",
    access: "approval-required",
    linkedAt: "2026-10-19T00:00:00.000Z",
    expiresAt: "2026-11-18T00:00:00.000Z",
  },
  token: "link-token",
};

type Answer =
  | { readonly status: number }
  | { readonly result: unknown }
  | { readonly rpcError: string };

/**
 * Runs body against a dispatch with one linked host and an SSH manager that
 * fails the test if anything reaches it. `answer` plays the host's /mcp.
 */
const withLinkedHost = <A, E>(
  answer: (request: {
    readonly method: string;
    readonly tool?: string;
    readonly args?: unknown;
  }) => Answer,
  body: Effect.Effect<A, E, SshRemoteDispatch.SshRemoteDispatch>,
  serverVersion = LINK.host.serverVersion,
) =>
  Effect.gen(function* () {
    const link = { ...LINK, host: { ...LINK.host, serverVersion } };
    const record: Array<{
      url: string;
      authorization: string | null;
      method: string;
      tool?: string;
    }> = [];
    const fetchEndpoint = vi.fn(async (url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id?: string;
        method: string;
        params?: { name?: string; arguments?: unknown };
      };
      record.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        method: request.method,
        ...(request.params?.name === undefined ? {} : { tool: request.params.name }),
      });
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
      const reply = answer({
        method: request.method,
        ...(request.params?.name === undefined ? {} : { tool: request.params.name }),
        args: request.params?.arguments,
      });
      if ("status" in reply) return new Response(null, { status: reply.status });
      if ("rpcError" in reply)
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: reply.rpcError },
        });
      return Response.json({ jsonrpc: "2.0", id: request.id, result: reply.result });
    });
    const noSsh = () => Effect.die("A linked host must not use SSH");
    const manager = SshTunnel.SshEnvironmentManager.of({
      status: noSsh,
      ensureEnvironment: noSsh,
      readyEnvironment: noSsh,
      beginSetupOperation: noSsh,
      publishSetupOutcome: noSsh,
      publishProviderDiagnosis: noSsh,
      forgetEnvironment: noSsh,
      disconnectEnvironment: noSsh,
      revalidateTunnels: () => Effect.void,
      issueClientSession: () => Effect.die("unused"),
      issueMcpClientSession: noSsh,
      runRemoteScript: noSsh,
    });
    const links = LinkedHosts.LinkedHosts.of({
      changes: Stream.empty,
      list: Effect.succeed([link.host]),
      find: (name) => Effect.succeed(name === "box" ? Option.some(link) : Option.none()),
      names: Effect.succeed(["box"]),
      link: () => Effect.die("unused"),
      unlink: () => Effect.die("unused"),
    });
    const discoverHosts = vi
      .spyOn(SshConfig, "discoverSshHosts")
      .mockReturnValue(Effect.succeed([]));
    const managerLayer = vi
      .spyOn(SshTunnel.SshEnvironmentManager, "layer")
      .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
    vi.stubGlobal("fetch", fetchEndpoint);
    try {
      const result = yield* body.pipe(
        Effect.result,
        Effect.provide(
          SshRemoteDispatch.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(Layer.succeed(LinkedHosts.LinkedHosts, links)),
            Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-linked-dispatch-" })),
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

const call = (tool: string, writes: boolean, mode: RuntimeMode = "approval-required") =>
  Effect.gen(function* () {
    const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
    const value = yield* dispatch.callHostTool(
      { host: "box", tool, arguments: { threadId: "thread-1" }, timeoutMs: 5_000, writes },
      Effect.succeed(mode),
    );
    return { value, connected: yield* dispatch.connectedHosts };
  });

describe("SshRemoteDispatch with a linked host", () => {
  it.effect("calls the host's /mcp over HTTPS with the link's session", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withLinkedHost(
        () => ({ result: { structuredContent: { threadId: "thread-1", title: "Remote" } } }),
        call("goat_thread_read", false),
      );
      expect(result).toMatchObject({
        _tag: "Success",
        success: { value: { threadId: "thread-1" }, connected: ["box"] },
      });
      expect(record.every((entry) => entry.url === "https://box.example.ts.net/mcp")).toBe(true);
      expect(record.every((entry) => entry.authorization === "Bearer link-token")).toBe(true);
      expect(record.at(-1)).toMatchObject({ method: "tools/call", tool: "goat_thread_read" });
    }),
  );

  it.effect("refuses approvals through a link and sends nothing", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withLinkedHost(
        () => ({ result: {} }),
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.callHostTool(
            {
              host: "box",
              tool: "goat_thread_send",
              arguments: {},
              timeoutMs: 5_000,
              writes: true,
              approvals: true,
            },
            Effect.succeed("full-access" as const),
          );
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "remote_refused", message: expect.stringContaining("approvals") },
      });
      expect(record).toEqual([]);
    }),
  );

  it.effect("asks for a new link when the host rejects the session", () =>
    Effect.gen(function* () {
      const { result } = yield* withLinkedHost(
        () => ({ status: 401 }),
        call("goat_thread_read", false),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "remote_refused",
          message: expect.stringContaining('goat_call {path:"host_link.create"}'),
        },
      });
    }),
  );

  it.effect("launches in an existing project there without browsing over SSH", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withLinkedHost(
        (request) => {
          if (request.method === "tools/list")
            return {
              result: {
                tools: [
                  {
                    name: "goat_thread_launch",
                    inputSchema: {
                      type: "object",
                      properties: { projectId: {}, title: {}, runtimeMode: {} },
                    },
                  },
                ],
              },
            };
          if (request.tool === "goat_project_list")
            return {
              result: {
                structuredContent: {
                  projects: [{ id: "project-1", workspaceRoot: "/srv/app" }],
                  nextCursor: null,
                },
              },
            };
          return { result: { structuredContent: { threadId: "thread-9", runId: "run-1" } } };
        },
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.launchThread(
            {
              host: "box",
              cwd: "/srv/app/",
              workspace: { type: "cwd" },
              title: "Fix it",
              message: "Go",
              runtimeMode: "approval-required",
              callerRuntimeMode: "full-access",
            },
            Effect.void,
          );
        }),
      );
      expect(result).toMatchObject({
        _tag: "Success",
        success: { host: "box", cwd: "/srv/app", projectId: "project-1", threadId: "thread-9" },
      });
      expect(
        record.filter((entry) => entry.method === "tools/call").map((entry) => entry.tool),
      ).toEqual(["goat_project_list", "goat_thread_launch"]);
    }),
  );

  it("reads a linked host's folder as an absolute local path", () => {
    expect(SshRemoteDispatch.linkedHostFolder("box", "~/app")).toContain("absolute path");
    expect(SshRemoteDispatch.linkedHostFolder("box", "//share/repo")).toContain("network share");
    expect(SshRemoteDispatch.linkedHostFolder("box", "\\\\share\\repo")).toContain("network share");
    expect(SshRemoteDispatch.linkedHostFolder("box", "/srv/./app/../app/")).toMatchObject({
      path: "/srv/app",
    });
    expect(SshRemoteDispatch.linkedHostFolder("box", "C:\\work\\app\\")).toMatchObject({
      path: "C:\\work\\app",
    });
  });

  it.effect("starts nothing in a folder that is not a project there", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withLinkedHost(
        (request) =>
          request.tool === "goat_project_list"
            ? { result: { structuredContent: { projects: [], nextCursor: null } } }
            : { result: {} },
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.launchThread(
            {
              host: "box",
              cwd: "/home/alice",
              workspace: { type: "cwd" },
              title: "Fix it",
              runtimeMode: "approval-required",
              callerRuntimeMode: "full-access",
            },
            Effect.void,
          );
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "remote_refused", message: expect.stringContaining("not a project") },
      });
      expect(
        record.filter((entry) => entry.method === "tools/call").map((entry) => entry.tool),
      ).toEqual(["goat_project_list"]);
    }),
  );

  it.effect.each([
    ["0.1.0-test", "task_status"],
    ["0.1.3", "goat_task_read"],
  ] as const)("calls a host at %s by the name it answers to: %s", ([version, sent]) =>
    Effect.gen(function* () {
      const { result, record } = yield* withLinkedHost(
        () => ({ result: { structuredContent: { taskId: "t" } } }),
        call("goat_task_read", false),
        version,
      );
      expect(result._tag).toBe("Success");
      expect(record.at(-1)).toMatchObject({ method: "tools/call", tool: sent });
    }),
  );

  it.effect("answers remote_outdated for a tool the host lacks, without running it here", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withLinkedHost(
        (request) =>
          request.method === "tools/call"
            ? { rpcError: `Tool '${request.tool}' not found` }
            : { result: {} },
        call("goat_provider_sync_read", false),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "remote_outdated",
          message: expect.stringContaining("GOAT on box does not have goat_provider_sync_read"),
        },
      });
      expect(record.at(-1)).toMatchObject({ tool: "goat_provider_sync_status" });
    }),
  );

  it.effect("keeps SSH tools off a linked name", () =>
    Effect.gen(function* () {
      const { result } = yield* withLinkedHost(
        () => ({ result: {} }),
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.browse({ host: "box" });
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "invalid_request",
          message: expect.stringContaining("linked GOAT host"),
        },
      });
    }),
  );
});
