import { ORCHESTRATION_V2_WS_METHODS, type EnvironmentId, type ThreadId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentShellState } from "./shell.ts";

const PAGE_SIZE = 100;
// Keep retained responses bounded; unqueried rows remain visible.
export const MAX_LINEAGE_LOOKUP_IDS = 1_000;
export interface LineageResolution {
  readonly checked: ReadonlySet<ThreadId>;
  readonly titles: Readonly<Record<string, string>>;
}

export function createThreadLineageLookup<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  shellState: (environmentId: EnvironmentId) => Atom.Atom<Pick<EnvironmentShellState, "removedAt">>,
) {
  const query = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:lineage-titles",
    tag: ORCHESTRATION_V2_WS_METHODS.getThreadFamily,
    staleTimeMs: 0,
    idleTtlMs: 0,
    refreshTrigger: ({ environmentId, input }) =>
      Atom.make((get) => {
        const { removedAt } = get(shellState(environmentId));
        return Math.max(-1, ...(input.lookupThreadIds ?? []).map((id) => removedAt.get(id) ?? -1));
      }),
  });
  const resolutions = Atom.family((key: string) => {
    const [environmentId, threadId, ids] = JSON.parse(key) as [EnvironmentId, ThreadId, ThreadId[]];
    return Atom.make((get): LineageResolution => {
      const checked = new Set<ThreadId>();
      const titles: Record<string, string> = Object.create(null);
      for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
        const page = ids.slice(offset, offset + PAGE_SIZE);
        const result = get(
          query({ environmentId, input: { threadId, lookupThreadIds: page, lookupOnly: true } }),
        );
        // A failed, pending or old-server response cannot establish deletion.
        if (result._tag !== "Success" || result.waiting || result.value.lookupTitles === undefined)
          break;
        Object.assign(titles, result.value.lookupTitles);
        for (const id of page) checked.add(id);
      }
      return { checked, titles };
    }).pipe(Atom.setIdleTTL(0));
  });
  return {
    query,
    resolution: (environmentId: EnvironmentId, threadId: ThreadId, ids: ReadonlyArray<ThreadId>) =>
      resolutions(JSON.stringify([environmentId, threadId, ids.slice(0, MAX_LINEAGE_LOOKUP_IDS)])),
  };
}
