import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { McpSchema, Tool } from "effect/ai";
import type { McpServer } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScreenRunService from "../../../screenCode/ScreenRunService.ts";
import { decodeAsAdvertised } from "../../decodeAsAdvertised.ts";
import { imageToolFailure } from "../../imageToolResult.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { screenRunMcpResult } from "./result.ts";
import { ScreenRunTool, ScreenToolkit, validScreenRunPayload } from "./tools.ts";

/** goat_screen_run returns image content, so McpHttpServer registers it as a raw MCP tool. */
export const screenRunTool = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const screen = yield* Effect.serviceOption(ScreenRunService.ScreenRunService);
  const built = yield* decodeAsAdvertised(ScreenToolkit);
  const tool = ScreenRunTool;
  return {
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        if (!validScreenRunPayload(payload))
          return Effect.succeed(
            new McpSchema.CallToolResult({
              isError: true,
              content: [{ type: "text", text: "Invalid screen run input." }],
            }),
          );
        if (Option.isNone(screen))
          return Effect.succeed(
            new McpSchema.CallToolResult({
              isError: true,
              content: [{ type: "text", text: "Screen run is unavailable on this GOAT host." }],
            }),
          );
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("goat_screen_run", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
          Effect.provideService(ScreenRunService.ScreenRunService, screen.value),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map(({ encodedResult }) => screenRunMcpResult(encodedResult)),
          Effect.matchCauseEffect({
            onFailure: imageToolFailure(tool.name, "screen_run", "Screen run failed."),
            onSuccess: Effect.succeed,
          }),
        );
      }),
  } satisfies Parameters<McpServer.McpServer["Service"]["addTool"]>[0];
});
