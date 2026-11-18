import type { ToolCallVisibility } from "@goat/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "./preferences";

/** This device's Beta choice for tool calls in chat; Show all until preferences load. */
export function useToolCallVisibility(): ToolCallVisibility {
  return useAtomValue(mobilePreferencesAtom, (preferences) =>
    AsyncResult.isSuccess(preferences)
      ? (preferences.value.toolCallVisibility ?? "showAll")
      : "showAll",
  );
}
