import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { useGlobalAgentStore } from "../../globalAgentStore";
import { useThreadShells } from "../../state/entities";
import { useBotThreadKeys } from "./useBotThreadKeys";

export function usePaletteHiddenParentKeys(): ReadonlySet<string> {
  const { hidden } = useBotThreadKeys();
  const ref = useGlobalAgentStore((state) => state.ref);
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const result = new Set(hidden);
  for (const parent of [ref, botRef]) {
    if (parent !== null)
      result.add(scopedThreadKey(scopeThreadRef(parent.environmentId, parent.threadId)));
  }
  return result;
}

export function useProjectOpenThreadShells() {
  const threads = useThreadShells();
  const hidden = usePaletteHiddenParentKeys();
  return threads.filter(
    (thread) => !hidden.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
}
