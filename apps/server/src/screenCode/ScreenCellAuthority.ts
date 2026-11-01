import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ThreadId } from "@goat/contracts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import {
  replaceWithTerminal,
  type ComputerUseTerminalReason,
  type ComputerUseTerminalState,
} from "../cua/ComputerUseTerminal.ts";
import type { ScreenHostBridge } from "./ScreenHostBridge.ts";
import {
  cellTerminalError,
  completionCellError,
  latchCellTerminal,
} from "./ScreenActionOutcome.ts";

export const screenRunFailure = (
  code: import("@goat/contracts").ScreenRunError["code"],
): import("@goat/contracts").ScreenRunError => ({
  code,
  effectStarted: false,
  nextStep: "Refresh the screen run and retry if appropriate.",
});

export const makeCellAuthority = (leases: ComputerUseLeases["Service"] | undefined) => {
  const cells = new Map<string, { cellId: string; controlId?: string }>();
  const current = (threadId: string) =>
    leases !== undefined
      ? leases
          .currentControl(ThreadId.make(threadId))
          .pipe(Effect.map((control) => Option.getOrUndefined(control)?.controlId))
      : Effect.void;
  return {
    get: (id: string) => cells.get(id)?.cellId,
    begin: (id: string, cellId: string, threadId: string) =>
      current(threadId).pipe(
        Effect.map((controlId) => {
          if (cells.has(id)) return false;
          cells.set(id, { cellId, ...(controlId === undefined ? {} : { controlId }) });
          return true;
        }),
      ),
    matches: (id: string, controlId: string | undefined) => {
      const owner = cells.get(id)?.controlId;
      return owner === undefined || controlId === undefined || owner === controlId;
    },
    delete: (id: string) => cells.delete(id),
  };
};

export const watchCellTerminals = (
  bridge: ScreenHostBridge,
  cells: ReturnType<typeof makeCellAuthority>,
) => {
  const terminals = new Map<string, ComputerUseTerminalReason>();
  const evidence = new Map<string, ComputerUseTerminalState>();
  bridge.terminalObserver = (context, reason, error) => {
    const id = `${context.runId}\u0000${context.turnId}`;
    if (cells.get(id) === context.cellId) {
      latchCellTerminal(terminals, id, reason);
      evidence.set(id, replaceWithTerminal(evidence.get(id) ?? "none", error));
    }
  };
  return { terminals, evidence };
};

export const finishCellResponse =
  (options: {
    readonly id: string;
    readonly cellId: string;
    readonly cells: ReturnType<typeof makeCellAuthority>;
    readonly terminals: Map<string, ComputerUseTerminalReason>;
    readonly evidence?: Map<string, ComputerUseTerminalState>;
    readonly onFinished?: () => void;
  }) =>
  <R>(
    work: Effect.Effect<
      import("@goat/contracts").ScreenRunResult,
      import("@goat/contracts").ScreenRunError,
      R
    >,
  ) => {
    let consumed = false;
    const cleanup = () => {
      if (consumed) return;
      consumed = true;
      if (options.cells.get(options.id) === options.cellId) options.cells.delete(options.id);
      options.terminals.delete(options.id);
      options.evidence?.delete(options.id);
      options.onFinished?.();
    };
    return work.pipe(
      Effect.result,
      Effect.flatMap((outcome) =>
        Effect.suspend(() => {
          const terminal = options.terminals.get(options.id);
          const evidence = options.evidence?.get(options.id);
          const response = (() => {
            if (outcome._tag === "Failure")
              return Effect.fail(
                terminal === undefined
                  ? outcome.failure
                  : cellTerminalError(
                      {
                        ...outcome.failure,
                        effectStarted: replaceWithTerminal(outcome.failure, evidence)
                          .possibleCommit,
                      },
                      outcome.failure.receipts ?? [],
                      terminal,
                    ),
              );
            if (terminal === undefined) return Effect.succeed(outcome.success);
            const receipts = outcome.success.journal.map((entry) => entry.receipt);
            const previous = outcome.success.error;
            const merged = replaceWithTerminal(previous ?? "none", evidence);
            const error = completionCellError(previous, receipts, terminal, merged);
            return error === undefined
              ? Effect.succeed(outcome.success)
              : Effect.fail({
                  ...error,
                  cellId: options.cellId,
                  receipts: receipts.slice(-16),
                  ...(outcome.success.windowsOpened === undefined
                    ? {}
                    : { windowsOpened: outcome.success.windowsOpened }),
                  ...(outcome.success.windowsOpenedTruncated === undefined
                    ? {}
                    : { windowsOpenedTruncated: outcome.success.windowsOpenedTruncated }),
                  ...(outcome.success.windowsOpenedUnverified === undefined
                    ? {}
                    : { windowsOpenedUnverified: outcome.success.windowsOpenedUnverified }),
                });
          })();
          cleanup();
          return response;
        }),
      ),
      Effect.ensuring(Effect.sync(cleanup)),
    );
  };
