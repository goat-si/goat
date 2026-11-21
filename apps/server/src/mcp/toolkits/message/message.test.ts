import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { catalog, client, dependencies } from "../../agentSurface.testkit.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";

const threadId = ThreadId.make("mid-turn-draft");
const providerInstanceId = ProviderInstanceId.make("claude");
const thread: McpInvocationScope = {
  environmentId: EnvironmentId.make("mid-turn-draft"),
  requestNamespace: "provider:mid-turn-draft",
  thread: { threadId, providerInstanceId, providerSessionId: "mid-turn-draft" },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const outside: McpInvocationScope = {
  ...thread,
  requestNamespace: "client:outside",
  thread: undefined,
  client: { sessionId: "outside", label: "Outside", access: "full-access" },
};
const services = catalog.pipe(
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          ...liveThreadShell(id, { interactionMode: "plan", runtimeMode: "approval-required" }),
          providerInstanceId,
        }),
    }),
  ),
  Layer.provide(dependencies),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
);

const call = (name: string, args: Record<string, unknown>, scope = thread) =>
  McpServer.McpServer.use((mcp) =>
    mcp
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      ),
  );

const show = (message: string, scope = thread) =>
  call("goat_call", { path: "message.show", args: { message } }, scope);

it.layer(services)("mid-turn message tool", (it) => {
  it.effect("returns the calling Plan-mode thread's full Markdown through goat_call", () =>
    Effect.gen(function* () {
      const message = " # Draft\n\nPlease confirm.\n";
      const result = yield* show(message);
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        value: { sentMessage: message },
      });
    }),
  );

  it.effect("refuses a blank or too-long message in UTF-16 units", () =>
    Effect.gen(function* () {
      for (const message of ["", " \t\n ", "😀".repeat(2_001)]) {
        const result = yield* show(message);
        expect(result.structuredContent).toMatchObject({
          status: "error",
          error: { code: "invalid_request" },
        });
      }
    }),
  );

  it.effect("refuses an outside MCP client directly and through the dispatcher", () =>
    Effect.gen(function* () {
      const direct = yield* call("goat_message_show", { message: "Draft" }, outside);
      expect(direct.isError).toBe(true);
      expect(JSON.stringify(direct.content)).toContain("thread_credential_required");
      const viaDispatcher = yield* show("Draft", outside);
      expect(viaDispatcher.structuredContent).toMatchObject({
        status: "error",
        error: { reason: "thread_credential_required" },
      });
    }),
  );
});
