import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts/settings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Settings from "../serverSettings.ts";
import { dependencies, serveOverHttp } from "./agentSurface.testkit.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { ComputerUseToolkit } from "./toolkits/computerUse/tools.ts";

const thread: McpInvocationScope = {
  environmentId: EnvironmentId.make("schema-environment"),
  requestNamespace: "schema-thread",
  thread: {
    threadId: ThreadId.make("schema-thread"),
    providerSessionId: "schema-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 0,
};

it.effect(
  "advertises and decodes foreground over HTTP tools/list, tools/call and goat_call",
  () => {
    const calls: Array<unknown> = [];
    // The shipped toolkit and registration decode input; only the domain handler records it.
    const record = McpToolAccess.actsAsCaller((params: unknown) =>
      Effect.sync(() => calls.push(params)).pipe(
        Effect.as({ kind: "available" as const, message: "Recorded request." }),
      ),
    );
    const registered = Layer.mergeAll(
      McpHttpServer.toolkitRegistration(
        ComputerUseToolkit,
        McpToolAccess.toLayer(ComputerUseToolkit, { goat_computer_use_request: record }),
      ),
      McpHttpServer.catalogRegistrations.agentSurface,
    ).pipe(Layer.provide(dependencies));
    return Effect.gen(function* () {
      const http = yield* serveOverHttp({ thread }, registered);
      const tool = (yield* http.listTools("thread")).find(
        ({ name }) => name === "goat_computer_use_request",
      );
      expect(tool?.inputSchema).toMatchObject({
        required: ["purpose"],
        properties: { foreground: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
      });
      const purpose = "Check the build status";
      for (const route of ["direct", "goat_call"] as const) {
        const invoke = (args: Record<string, unknown>) =>
          route === "direct"
            ? http.callTool("thread", "goat_computer_use_request", args)
            : http.callTool("thread", "goat_call", { path: "computer_use.request", args });
        for (const input of [
          { purpose },
          { purpose, foreground: false },
          { purpose, foreground: true },
          { purpose, foreground: null },
        ]) {
          const result = yield* invoke(input);
          expect(result.isError).toBe(false);
          if (route === "goat_call")
            expect(result.structuredContent).toMatchObject({ status: "ok" });
        }
        const before = calls.length;
        for (const foreground of ["true", 1, {}, []]) {
          const rejected = yield* invoke({ purpose, foreground });
          if (route === "direct") expect(rejected.isError).toBe(true);
          else
            expect(rejected.structuredContent).toMatchObject({
              status: "error",
              error: { code: "invalid_request" },
            });
        }
        expect(calls).toHaveLength(before);
      }
      expect(calls).toEqual([
        { purpose },
        { purpose, foreground: false },
        { purpose, foreground: true },
        { purpose },
        { purpose },
        { purpose, foreground: false },
        { purpose, foreground: true },
        { purpose },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Settings.ServerSettingsService)({
            getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, agentToolListing: "full" }),
          }),
          NodeHttpServer.layerTest,
        ),
      ),
    );
  },
);
