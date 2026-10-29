import { expect, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as AcpSessionService from "../../../provider/AcpSessionService.ts";
import { catalog, client, dependencies } from "../../agentSurface.testkit.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";

const input = {
  instanceId: ProviderInstanceId.make("acp-test"),
  projectId: ProjectId.make("project-test"),
  cursor: "next",
};
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  requestNamespace: "test",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "test", label: "test", access: "read-only" },
  grantedScopes: ["orchestration:read"],
  reauthorize: () => Effect.void,
};

it.effect("lists a page through the served MCP path only while read access is live", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const required = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    const service = Layer.mock(AcpSessionService.AcpSessionService)({
      list: (received) =>
        Ref.update(calls, (n) => n + 1).pipe(
          Effect.as({
            sessions: [],
            truncated: true,
            nextCursor: received.cursor ?? null,
            canLoad: true,
            canResume: false,
            canDelete: false,
          }),
        ),
    });
    const registered = catalog.pipe(
      Layer.provide(Layer.mergeAll(dependencies, service)),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    const call = (as: McpInvocationScope) =>
      McpServer.McpServer.pipe(
        Effect.flatMap((server) =>
          server.callTool({ name: "goat_acp_session_list", arguments: input }),
        ),
        Effect.provideService(McpInvocationContext, as),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    yield* Effect.gen(function* () {
      const allowed = yield* call({
        ...scope,
        reauthorize: (scopes) => Ref.update(required, (all) => [...all, scopes]),
      });
      expect(allowed.isError).toBe(false);
      expect(allowed.structuredContent).toMatchObject({
        nextCursor: "next",
        sessions: [],
        truncated: true,
      });
      expect(yield* Ref.get(required)).toEqual([["orchestration:read"]]);
      const denied = yield* call({
        ...scope,
        reauthorize: () =>
          Effect.fail(
            new EnvironmentAuthorizationError({
              message: "revoked",
              requiredScope: "orchestration:read",
            }),
          ),
      });
      expect(denied.isError).toBe(true);
      const thread: McpInvocationScope = {
        ...scope,
        client: undefined,
        thread: {
          threadId: ThreadId.make("thread-test"),
          providerSessionId: "session-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      };
      const threadResult = yield* call(thread);
      expect(threadResult.isError).toBe(false);
      expect(threadResult.structuredContent).toMatchObject({ nextCursor: "next", truncated: true });
      const withoutCapability = yield* call({ ...thread, capabilities: new Set() });
      expect(withoutCapability.isError).toBe(true);
      expect(withoutCapability.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("orchestration access") }),
        ]),
      );
      expect(yield* Ref.get(calls)).toBe(2);
    }).pipe(Effect.provide(registered));
  }),
);
