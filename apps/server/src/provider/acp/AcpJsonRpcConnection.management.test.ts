import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import { mockAgentCommand, mockAgentArgs } from "./AcpJsonRpcConnection.testkit.ts";

describe("AcpSessionRuntime management", () => {
  it.effect("supports v2 session deletion and secret-safe provider management", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.deleteSession("native-session-1");
      expect((yield* runtime.listProviders).providers[0]).toMatchObject({
        providerId: "mock-provider",
        current: null,
      });
      yield* runtime.setProvider({
        providerId: "mock-provider",
        apiType: "openai",
        baseUrl: "https://api.example.test/v1",
        headers: { Authorization: "Bearer top-secret" },
      });
      expect((yield* runtime.listProviders).providers[0]?.current).toEqual({
        apiType: "openai",
        baseUrl: "https://api.example.test/v1",
      });
      yield* runtime.disableProvider("mock-provider");
      expect((yield* runtime.listProviders).providers[0]?.current).toBeNull();

      const setRequest = requestEvents.find(
        (event) => event.method === "providers/set" && event.status === "started",
      );
      expect(setRequest?.payload).toMatchObject({
        headers: { Authorization: "[redacted]" },
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { GOAT_ACP_V2_MANAGEMENT: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("authenticates explicitly typed v2 agent methods and retries session creation", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionId).toBe("mock-session-1");
      expect(
        requestEvents.filter((event) => event.status === "started").map((event) => event.method),
      ).toEqual(["initialize", "session/new", "authenticate", "session/new"]);
      expect(
        requestEvents.filter(
          (event) => event.method === "session/new" && event.status === "failed",
        ),
      ).toHaveLength(1);
      expect(
        requestEvents.filter(
          (event) => event.method === "session/new" && event.status === "succeeded",
        ),
      ).toHaveLength(1);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              GOAT_ACP_AUTH_METHOD_ID: "test",
              GOAT_ACP_REQUIRE_AUTH: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("can surface auth-required without authenticating during discovery", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    let advertisedAuthMethodName: string | undefined;
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const result = yield* Effect.result(runtime.start());

      expect(Result.isFailure(result)).toBe(true);
      expect(advertisedAuthMethodName).toBe("Mock agent authentication");
      expect(
        requestEvents.filter((event) => event.status === "started").map((event) => event.method),
      ).toEqual(["initialize", "session/new"]);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authenticateOnAuthRequired: false,
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              GOAT_ACP_AUTH_METHOD_ID: "test",
              GOAT_ACP_REQUIRE_AUTH: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          onInitialized: (initializeResult) =>
            Effect.sync(() => {
              advertisedAuthMethodName = initializeResult.authMethods?.[0]?.name;
            }),
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("supports negotiated ACP session list, fork, resume, and close methods", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult.agentCapabilities?.sessionCapabilities).toMatchObject({
        list: {},
        fork: {},
        resume: {},
        close: {},
      });
      expect(started.initializeResult.agentCapabilities?.auth).toMatchObject({ logout: {} });

      const listed = yield* runtime.listSessions();
      expect(listed.sessions.map((session) => session.sessionId)).toEqual(["mock-session-1"]);

      const forked = yield* runtime.forkSession(started.sessionId);
      expect(forked.sessionId).toBe("mock-session-1-fork");
      yield* runtime.prompt({ prompt: [{ type: "text", text: "on fork" }] });

      const resumed = yield* runtime.resumeSession(started.sessionId);
      expect(resumed.sessionId).toBe("mock-session-1");
      yield* runtime.closeSession();
      yield* runtime.logout;

      expect(
        requestEvents.find(
          (event) => event.method === "session/prompt" && event.status === "started",
        )?.payload,
      ).toMatchObject({ sessionId: "mock-session-1-fork" });
      expect(
        requestEvents.filter((event) => event.status === "started").map((event) => event.method),
      ).toEqual(
        expect.arrayContaining([
          "session/list",
          "session/fork",
          "session/resume",
          "session/close",
          "logout",
        ]),
      );
      // Omitted roots clear an agent's stored ones, so every activation resends them.
      for (const method of ["session/new", "session/fork", "session/resume"]) {
        expect(
          requestEvents.find((event) => event.method === method && event.status === "started")
            ?.payload,
        ).toMatchObject({
          additionalDirectories: ["/tmp/t3-attachments"],
          _meta: { negotiated: "0.0.0" },
        });
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              GOAT_ACP_SESSION_LIFECYCLE: "1",
            },
          },
          additionalDirectories: ["/tmp/t3-attachments"],
          sessionMeta: (initializeResult) => ({
            negotiated: initializeResult.agentInfo?.version ?? "none",
          }),
          cwd: process.cwd(),
          clientInfo: { name: "t3-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("rejects unauthenticated ACP session lifecycle requests", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const listError = yield* runtime.listSessions().pipe(Effect.flip);
      expect(listError._tag).toBe("AcpRequestError");
      if (listError._tag === "AcpRequestError") {
        expect(listError.code).toBe(-32000);
      }

      const forkError = yield* runtime.forkSession("mock-session-1").pipe(Effect.flip);
      expect(forkError._tag).toBe("AcpRequestError");
      if (forkError._tag === "AcpRequestError") {
        expect(forkError.code).toBe(-32000);
      }

      const resumeError = yield* runtime.resumeSession("mock-session-1").pipe(Effect.flip);
      expect(resumeError._tag).toBe("AcpRequestError");
      if (resumeError._tag === "AcpRequestError") {
        expect(resumeError.code).toBe(-32000);
      }

      const closeError = yield* runtime.closeSession().pipe(Effect.flip);
      expect(closeError._tag).toBe("AcpRequestError");
      if (closeError._tag === "AcpRequestError") {
        expect(closeError.code).toBe(-32000);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              GOAT_ACP_REQUIRE_AUTH: "1",
              GOAT_ACP_SESSION_LIFECYCLE: "1",
            },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          clientInfo: { name: "t3-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
});
