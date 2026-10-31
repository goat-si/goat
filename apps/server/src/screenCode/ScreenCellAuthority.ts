import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ThreadId } from "@goat/contracts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import type { ComputerUseTerminalReason } from "../cua/ComputerUseTerminal.ts";
import type { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { latchCellTerminal } from "./ScreenActionOutcome.ts";

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
  bridge.terminalObserver = (context, reason) => {
    const id = `${context.runId}\u0000${context.turnId}`;
    if (cells.get(id) === context.cellId) latchCellTerminal(terminals, id, reason);
  };
  return terminals;
};
