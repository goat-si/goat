import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const LaneKind = Schema.Literals([
  "research",
  "implement",
  "review",
  "verify",
  "merge",
  "sweep",
]);
export type LaneKind = typeof LaneKind.Type;

/** `dispatch` runs through GOAT launch tools; `native` is a provider subagent sharing its parent's session. */
export const LaneMode = Schema.Literals(["dispatch", "native"]);
export type LaneMode = typeof LaneMode.Type;

/** A thread on this environment, or on an SSH or linked host when `host` is set. */
export const LaneThreadRef = Schema.Struct({
  threadId: ThreadId,
  host: Schema.optionalKey(TrimmedNonEmptyString),
});
export type LaneThreadRef = typeof LaneThreadRef.Type;

export const GoatclawLane = Schema.Struct({
  kind: LaneKind,
  mode: LaneMode,
  profile: TrimmedNonEmptyString,
  host: Schema.optionalKey(TrimmedNonEmptyString),
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  parent: LaneThreadRef,
  reportTo: LaneThreadRef,
}).check(
  Schema.makeFilter((lane) =>
    lane.mode === "native" && lane.host !== lane.parent.host
      ? "A native lane runs on its parent's host."
      : undefined,
  ),
);
export type GoatclawLane = typeof GoatclawLane.Type;
