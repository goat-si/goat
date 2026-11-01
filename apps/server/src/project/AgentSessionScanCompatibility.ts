import type {
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionScanInput,
  AgentSessionScanResult,
  AgentSessionSource,
} from "@goat/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ScanAgentSessions = (
  input: AgentSessionScanInput,
) => Effect.Effect<AgentSessionScanResult, AgentSessionScanError>;

export function filterCandidates<A extends { readonly source: AgentSessionSource }>(
  input: AgentSessionScanInput,
  candidates: ReadonlyArray<A>,
): ReadonlyArray<A> {
  return input.includePi === true ? candidates : candidates.filter(({ source }) => source !== "pi");
}

export type RecentAgentSessions<A> = (
  workspaceRoot: string,
  completedSources?: ReadonlyArray<AgentSessionImportSource>,
  input?: AgentSessionScanInput,
) => Stream.Stream<A, AgentSessionScanError>;
