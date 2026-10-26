import type { RuntimeMode } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";
import { withLinkedHost } from "./testkit/LinkedHostFixture.ts";

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
      ).toEqual(["goat_environment_read", "goat_project_list", "goat_thread_launch"]);
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
      ).toEqual(["goat_environment_read", "goat_project_list"]);
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
