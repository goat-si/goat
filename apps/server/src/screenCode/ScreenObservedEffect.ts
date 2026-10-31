import type { ScreenHostCall, ScreenJournalEntry } from "@goat/contracts";
import type { ScreenHostDispatchResult } from "./ScreenHostBridge.ts";

const APP_INPUTS: ReadonlySet<ScreenHostCall["method"]> = new Set([
  "click",
  "right_click",
  "hover",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "set_value",
  "bring_to_front",
  "select",
  "select_text",
  "invoke_menu",
]);
export function applyObservedEffect(
  state: {
    journal: ScreenJournalEntry[];
    pendingObserved: Map<string, Array<{ index: number; window: string; baseline: string }>>;
  },
  call: ScreenHostCall,
  result: ScreenHostDispatchResult,
  admittedIndex: number | undefined,
  value: unknown,
): unknown {
  if (call.targetRef?.kind === "app") {
    const target = call.targetRef.id;
    if (call.method === "get_accessibility_tree" || call.method === "get_window_state") {
      const pending = state.pendingObserved.get(target) ?? [];
      state.pendingObserved.delete(target);
      const observation = typeof value === "object" && value !== null ? value : undefined;
      if (
        observation &&
        "mode" in observation &&
        observation.mode === "diff" &&
        "baseObservationId" in observation &&
        typeof observation.baseObservationId === "string" &&
        "indexedText" in observation &&
        typeof observation.indexedText === "string" &&
        result.observedWindow !== undefined
      ) {
        const matched = pending.filter(
          (item) =>
            item.window === result.observedWindow &&
            item.baseline === observation.baseObservationId,
        );
        const rows = observation.indexedText
          .split("\n")
          .filter((line) => /^[+~-]\s/.test(line))
          .slice(0, 16)
          .map((line) => line.slice(0, 200));
        const noChange = /^no change\b/i.test(observation.indexedText);
        if (matched.length && (rows.length || noChange)) {
          const first = matched[0] && state.journal[matched[0].index]?.receipt;
          const label =
            matched.length === 1
              ? `after ${first?.method ?? "input"}`
              : `after ${matched.length} inputs`;
          const effect = noChange
            ? `${label}: no change seen in this window; effect may be elsewhere, check before resending`
            : `${label}: changed (${rows[0]})`;
          const observedEffect = {
            state: noChange ? ("no_change_seen" as const) : ("change_seen" as const),
            rows,
          };
          for (const item of matched) {
            const entry = state.journal[item.index];
            if (entry)
              state.journal[item.index] = {
                ...entry,
                receipt: { ...entry.receipt, observedEffect },
              };
          }
          value = { ...observation, effect: effect.slice(0, 256) };
        }
      }
    } else if (
      APP_INPUTS.has(call.method) &&
      admittedIndex !== undefined &&
      result.observedWindow !== undefined &&
      result.observedBaseline !== undefined &&
      result.safety?.possibleCommit
    ) {
      const pending = state.pendingObserved.get(target) ?? [];
      pending.push({
        index: admittedIndex,
        window: result.observedWindow,
        baseline: result.observedBaseline,
      });
      state.pendingObserved.set(target, pending);
    }
  }
  return value;
}
