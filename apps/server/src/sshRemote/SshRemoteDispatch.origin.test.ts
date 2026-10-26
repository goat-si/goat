import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import { SshLaunchError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";

import { host, initialize, withRemote } from "./SshRemoteDispatch.hostCall.testkit.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

describe("SSH dispatch origin routing", () => {
  const withExistingManager = <A, E>(
    extension: Partial<SshTunnel.SshEnvironmentManagerShape>,
    options: Parameters<typeof withRemote>[0],
    body: Effect.Effect<A, E, SshRemoteDispatch.SshRemoteDispatch>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const original = SshTunnel.SshEnvironmentManager.of;
        return vi
          .spyOn(SshTunnel.SshEnvironmentManager, "of")
          .mockImplementation((service) => original({ ...service, ...extension }));
      }),
      () => withRemote(options, body),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  it.effect.each([
    ["reads a managed thread after the app becomes primary", "managed-owner", "managed-token"],
    ["keeps app thread reads on app while managed is primary", "app-owner", "app-token"],
  ] as const)("%s", ([, origin, token]) =>
    Effect.gen(function* () {
      const requests: Array<{ tool: string; bearer: string | null }> = [];
      const { result, record } = yield* withExistingManager(
        {
          existingEnvironment: () =>
            Effect.succeed({ httpBaseUrl: "http://127.0.0.1:42000/", remoteServerVersion: "test" }),
          issueExistingMcpSession: () =>
            Effect.succeed({ token, expiresAt: null, runtimeModeCeilingApplied: true }),
        },
        {
          answer: (request) => {
            const initial = initialize(request);
            if (initial !== undefined) return initial;
            if (request.method === "tools/list")
              return { result: { tools: [{ name: "goat_thread_read" }] } };
            if (request.tool !== undefined)
              requests.push({ tool: request.tool, bearer: request.authorization });
            return { result: { structuredContent: { threadId: "thread-1" } } };
          },
        },
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.callHostTool(
            {
              host,
              environmentId: EnvironmentId.make(origin),
              tool: "goat_thread_read",
              arguments: { threadId: "thread-1" },
              writes: false,
              timeoutMs: 5_000,
            },
            Effect.succeed("full-access"),
          );
        }),
      );
      expect(result._tag).toBe("Success");
      expect(requests).toContainEqual({ tool: "goat_thread_read", bearer: `Bearer ${token}` });
      expect(record.sessionsIssued).toBe(0);
    }),
  );

  it.effect("known offline origin is unavailable without calling the active database", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withExistingManager(
        {
          existingEnvironment: () =>
            Effect.fail(new SshLaunchError({ message: "offline", stdout: "" })),
        },
        { answer: (request) => initialize(request) ?? { result: {} } },
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.callHostTool(
            {
              host,
              environmentId: EnvironmentId.make("offline-owner"),
              tool: "goat_thread_read",
              arguments: { threadId: "thread-1" },
              writes: false,
              timeoutMs: 5_000,
            },
            Effect.succeed("full-access"),
          );
        }),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "host_unavailable" } });
      expect(record.toolCalls).toEqual([]);
      expect(record.sessionsIssued).toBe(0);
    }),
  );

  it.effect("legacy thread read retries the other live database once after thread_not_found", () =>
    Effect.gen(function* () {
      const requested: Array<{ tool: string; bearer: string | null }> = [];
      const ceilings: Array<string | null> = [];
      const { result } = yield* withExistingManager(
        {
          existingEnvironmentOther: (_target, current) =>
            Effect.succeed(
              current === EnvironmentId.make("app-owner")
                ? { kind: "live", environmentId: EnvironmentId.make("managed-owner") }
                : { kind: "absent" },
            ),
          existingEnvironment: () =>
            Effect.succeed({ httpBaseUrl: "http://127.0.0.1:42000/", remoteServerVersion: "test" }),
          issueExistingMcpSession: (_target, _id, options) => {
            ceilings.push(options.runtimeModeCeiling);
            return Effect.succeed({
              token: "managed-token",
              expiresAt: null,
              runtimeModeCeilingApplied: true,
            });
          },
        },
        {
          answer: (request) => {
            const initial = initialize(request);
            if (initial !== undefined) return initial;
            if (request.method === "tools/list")
              return { result: { tools: [{ name: "goat_thread_read" }] } };
            if (request.tool !== undefined)
              requested.push({ tool: request.tool, bearer: request.authorization });
            if (request.tool === "goat_environment_read")
              return { result: { structuredContent: { environmentId: "app-owner" } } };
            if (request.authorization === "Bearer managed-token")
              return { result: { structuredContent: { threadId: "thread-1" } } };
            return {
              result: {
                isError: true,
                structuredContent: { code: "thread_not_found", message: "missing" },
              },
            };
          },
        },
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.callHostTool(
            {
              host,
              tool: "goat_thread_read",
              arguments: { threadId: "thread-1" },
              writes: false,
              timeoutMs: 5_000,
            },
            Effect.succeed("full-access"),
          );
        }),
      );
      expect(result).toMatchObject({ _tag: "Success", success: { threadId: "thread-1" } });
      expect(requested.filter(({ tool }) => tool === "goat_thread_read")).toEqual([
        { tool: "goat_thread_read", bearer: "Bearer session-1" },
        { tool: "goat_thread_read", bearer: "Bearer managed-token" },
      ]);
      expect(ceilings).toEqual(["full-access"]);
    }),
  );

  it.effect("never guesses another database for writes or authorization failures", () =>
    Effect.gen(function* () {
      const routed = yield* withExistingManager(
        {
          existingEnvironment: () =>
            Effect.succeed({ httpBaseUrl: "http://127.0.0.1:42000/", remoteServerVersion: "test" }),
          issueExistingMcpSession: () =>
            Effect.succeed({
              token: "managed-token",
              expiresAt: null,
              runtimeModeCeilingApplied: true,
            }),
        },
        {
          answer: (request) =>
            initialize(request) ?? { result: { structuredContent: { threadId: "thread-1" } } },
        },
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.callHostTool(
            {
              host,
              environmentId: EnvironmentId.make("managed-owner"),
              tool: "goat_thread_read",
              arguments: { threadId: "thread-1" },
              writes: false,
              timeoutMs: 5_000,
            },
            Effect.succeed("full-access"),
          );
        }),
      );
      expect(routed.result).toMatchObject({ _tag: "Success" });
      expect(routed.record.sessionsIssued).toBe(0);
      for (const response of ["missing", "unauthorized"] as const) {
        let alternateCalls = 0;
        const { result } = yield* withExistingManager(
          {
            existingEnvironmentOther: () => {
              alternateCalls++;
              return Effect.succeed({ kind: "live", environmentId: EnvironmentId.make("other") });
            },
          },
          {
            answer: (request) => {
              const initial = initialize(request);
              if (initial !== undefined) return initial;
              if (request.method === "tools/list")
                return {
                  result: {
                    tools: [
                      { name: response === "missing" ? "goat_thread_send" : "goat_thread_read" },
                    ],
                  },
                };
              return response === "unauthorized"
                ? { status: 401 }
                : {
                    result: {
                      isError: true,
                      structuredContent: { code: "thread_not_found", message: "missing" },
                    },
                  };
            },
          },
          Effect.gen(function* () {
            const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
            return yield* dispatch.callHostTool(
              {
                host,
                tool: response === "missing" ? "goat_thread_send" : "goat_thread_read",
                arguments: { threadId: "thread-1" },
                writes: response === "missing",
                timeoutMs: 5_000,
              },
              Effect.succeed("full-access"),
            );
          }),
        );
        expect(result._tag).toBe("Failure");
        expect(alternateCalls).toBe(0);
      }
    }),
  );
});
