import type {
  AgentSessionScanError,
  AgentSessionScanInput,
  AgentSessionScanResult,
  AgentSessionSource,
} from "@goat/contracts";
import type * as Effect from "effect/Effect";

export type ScanAgentSessions = (
  input: AgentSessionScanInput,
) => Effect.Effect<AgentSessionScanResult, AgentSessionScanError>;

export function filterCandidates<A extends { readonly source: AgentSessionSource }>(
  input: AgentSessionScanInput,
  candidates: ReadonlyArray<A>,
): ReadonlyArray<A> {
  return input.includePi === true ? candidates : candidates.filter(({ source }) => source !== "pi");
}
