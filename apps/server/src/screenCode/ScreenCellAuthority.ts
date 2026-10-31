import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ThreadId } from "@goat/contracts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";

export const makeCellAuthority = (leases: ComputerUseLeases["Service"] | undefined) => {
  const cells = new Map<string, { cellId: string; controlId?: string }>();
  const current = (threadId: string) =>
    leases !== undefined
      ? leases
          .currentControl(ThreadId.make(threadId))
          .pipe(Effect.map((control) => Option.getOrUndefined(control)?.controlId))
      : Effect.succeed(undefined);
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
