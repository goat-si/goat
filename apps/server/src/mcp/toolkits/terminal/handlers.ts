import * as Effect from "effect/Effect";
import { AgentTerminalMcpService } from "../../AgentTerminalMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { TerminalToolkit } from "./tools.ts";

export const layer = Access.toLayer(TerminalToolkit, {
  goat_terminal_list: Access.reads(() =>
    Effect.gen(function* () {
      return yield* (yield* AgentTerminalMcpService).list(yield* McpInvocationContext);
    }),
  ),
  goat_terminal_read: Access.reads((input) =>
    Effect.gen(function* () {
      return yield* (yield* AgentTerminalMcpService).read(yield* McpInvocationContext, input);
    }),
  ),
  goat_terminal_open: Access.destructive(
    Access.writesWithCapability(
      () =>
        Effect.gen(function* () {
          return yield* (yield* AgentTerminalMcpService).open(yield* McpInvocationContext);
        }),
      { admission: "handler" },
    ),
  ),
  goat_terminal_write: Access.destructive(
    Access.writesWithCapability(
      (input) =>
        Effect.gen(function* () {
          return yield* (yield* AgentTerminalMcpService).mutate(
            yield* McpInvocationContext,
            input,
            "write",
          );
        }),
      { admission: "handler" },
    ),
  ),
  goat_terminal_clear: Access.destructive(
    Access.writesWithCapability(
      (input) =>
        Effect.gen(function* () {
          return yield* (yield* AgentTerminalMcpService).mutate(
            yield* McpInvocationContext,
            input,
            "clear",
          );
        }),
      { admission: "handler" },
    ),
  ),
  goat_terminal_restart: Access.destructive(
    Access.writesWithCapability(
      (input) =>
        Effect.gen(function* () {
          return yield* (yield* AgentTerminalMcpService).mutate(
            yield* McpInvocationContext,
            input,
            "restart",
          );
        }),
      { admission: "handler" },
    ),
  ),
  goat_terminal_close: Access.destructive(
    Access.writesWithCapability(
      (input) =>
        Effect.gen(function* () {
          return yield* (yield* AgentTerminalMcpService).mutate(
            yield* McpInvocationContext,
            input,
            "close",
          );
        }),
      { admission: "handler" },
    ),
  ),
});
