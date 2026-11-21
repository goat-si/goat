import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as AcpSchema from "effect-acp/compat";
import type { AcpAdapterV2ExtensionContext } from "@goat/provider-acp/server/adapter";
import { makeCopilotSubagentRouting } from "./copilotAcp.ts";

describe("Copilot tool identity correlation", () => {
  it.effect(
    "isolates sessions, ignores late duplicates, evicts old calls and clears on release",
    () =>
      Effect.gen(function* () {
        const routing = makeCopilotSubagentRouting();
        let callback:
          | ((event: {
              sessionId: string;
              type: string;
              data: Record<string, unknown>;
            }) => Effect.Effect<void>)
          | undefined;
        const runtime = {
          handleExtNotification: (_name: string, _schema: unknown, handler: typeof callback) => {
            callback = handler;
            return Effect.void;
          },
        } as unknown as AcpAdapterV2ExtensionContext["runtime"];
        yield* routing.registerExtensions({ runtime } as AcpAdapterV2ExtensionContext);
        const start = (sessionId: string, callId: string, toolName = "glob") => {
          if (callback === undefined) throw new Error("extension handler was not registered");
          return callback({
            sessionId,
            type: "tool.execution_start",
            data: { toolCallId: callId, toolName },
          });
        };
        const update = (sessionId: string, toolCallId: string, status = "completed") =>
          routing.normalizeSessionUpdate(
            {
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId,
                status,
                title: "read",
                kind: "read",
              },
            } as AcpSchema.SessionNotification,
            runtime,
          ).update;
        yield* start("a", "same");
        expect(update("b", "same")).toMatchObject({ kind: "read" });
        expect(update("a", "same")).toMatchObject({ kind: "search" });
        yield* start("a", "same");
        expect(update("a", "same")).toMatchObject({ kind: "read" });
        for (let i = 0; i < 257; i++) yield* start("a", `pending-${i}`);
        expect(update("a", "pending-0")).toMatchObject({ kind: "read" });
        expect(update("a", "pending-256")).toMatchObject({ kind: "search" });
        for (let group = 0; group < 17; group++) {
          for (let i = 0; i < 256; i++) yield* start(`group-${group}`, `call-${i}`);
        }
        expect(update("group-0", "call-0")).toMatchObject({ kind: "read" });
        expect(update("group-16", "call-255")).toMatchObject({ kind: "search" });
        yield* start("a", "before-release");
        yield* routing.releaseRuntime(runtime);
        yield* start("a", "after-release");
        expect(update("a", "before-release")).toMatchObject({ kind: "read" });
        expect(update("a", "after-release")).toMatchObject({ kind: "read" });
      }),
  );

  it.effect("disables only the session that exhausts its seen-call budget", () =>
    Effect.gen(function* () {
      const routing = makeCopilotSubagentRouting();
      let callback:
        | ((event: {
            sessionId: string;
            type: string;
            data: Record<string, unknown>;
          }) => Effect.Effect<void>)
        | undefined;
      const runtime = {
        handleExtNotification: (_name: string, _schema: unknown, handler: typeof callback) => {
          callback = handler;
          return Effect.void;
        },
      } as unknown as AcpAdapterV2ExtensionContext["runtime"];
      yield* routing.registerExtensions({ runtime } as AcpAdapterV2ExtensionContext);
      const start = (sessionId: string, callId: string) => {
        if (callback === undefined) throw new Error("extension handler was not registered");
        return callback({
          sessionId,
          type: "tool.execution_start",
          data: { toolCallId: callId, toolName: "glob" },
        });
      };
      const update = (sessionId: string, toolCallId: string) =>
        routing.normalizeSessionUpdate(
          {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              status: "completed",
              title: "read",
              kind: "read",
            },
          } as AcpSchema.SessionNotification,
          runtime,
        ).update;
      for (let i = 0; i < 8193; i++) {
        yield* start("full", String(i));
        update("full", String(i));
      }
      yield* start("full", "after");
      yield* start("other", "after");
      expect(update("full", "after")).toMatchObject({ kind: "read" });
      expect(update("other", "after")).toMatchObject({ kind: "search" });
      yield* routing.releaseRuntime(runtime);
    }),
  );
});
