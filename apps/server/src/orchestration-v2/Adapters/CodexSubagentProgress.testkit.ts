import { assert } from "@effect/vitest";
import type { ProviderAdapterV2Event } from "@goat/provider-core/server/ProviderAdapter";

export function assertSubagentProgress(
  events: ReadonlyArray<Extract<ProviderAdapterV2Event, { type: "subagent.updated" }>>,
) {
  assert.isDefined(
    events.find((event) => event.subagent.status === "running" && event.subagent.progress),
    "a running native subagent reports its child's current command as progress",
  );
}
