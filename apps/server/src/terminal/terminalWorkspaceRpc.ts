import {
  WS_METHODS,
  type TerminalAttachInput,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as TerminalManager from "./Manager.ts";

/** The terminal RPCs that start a shell in a folder, kept here so ws.ts only spreads them in. */
export const terminalWorkspaceRpcHandlers = Effect.fn("terminalWorkspaceRpcHandlers")(function* (
  terminalViewerId: (metadata: { readonly client: { readonly id: number } }) => string,
) {
  const terminalManager = yield* TerminalManager.TerminalManager;
  return {
    [WS_METHODS.terminalOpen]: (input: TerminalOpenInput) => terminalManager.open(input),
    [WS_METHODS.terminalAttach]: (
      input: TerminalAttachInput,
      metadata: { readonly client: { readonly id: number } },
    ) => terminalManager.attachOutputStream(input, terminalViewerId(metadata)),
    [WS_METHODS.terminalRestart]: (input: TerminalRestartInput) => terminalManager.restart(input),
  } as const;
});
