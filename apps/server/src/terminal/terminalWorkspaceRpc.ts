import {
  WS_METHODS,
  type TerminalAttachInput,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ThreadWorkspaceService } from "../orchestration-v2/goat/ThreadWorkspaceService.ts";
import * as TerminalManager from "./Manager.ts";

/**
 * The terminal RPCs that start a shell in a folder, kept here so ws.ts only spreads them in. A
 * thread's worktree that cleanup removed comes back first, with the same notice a turn leaves.
 */
export const terminalWorkspaceRpcHandlers = Effect.fn("terminalWorkspaceRpcHandlers")(function* (
  terminalViewerId: (metadata: { readonly client: { readonly id: number } }) => string,
) {
  const terminalManager = yield* TerminalManager.TerminalManager;
  const workspaces = yield* ThreadWorkspaceService;
  return {
    [WS_METHODS.terminalOpen]: (input: TerminalOpenInput) =>
      workspaces.prepareTerminal(input).pipe(Effect.andThen(terminalManager.open(input))),
    [WS_METHODS.terminalAttach]: (
      input: TerminalAttachInput,
      metadata: { readonly client: { readonly id: number } },
    ) =>
      Stream.unwrap(
        workspaces
          .prepareTerminal(input)
          .pipe(Effect.as(terminalManager.attachOutputStream(input, terminalViewerId(metadata)))),
      ),
    [WS_METHODS.terminalRestart]: (input: TerminalRestartInput) =>
      workspaces.prepareTerminal(input).pipe(Effect.andThen(terminalManager.restart(input))),
  } as const;
});
