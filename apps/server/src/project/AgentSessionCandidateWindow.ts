import type { AgentSessionSource } from "@goat/contracts";

import { codexThreadIdFromRolloutPath } from "./CodexStateDatabase.ts";
import type { CodexHistoryThreadRef } from "./CodexThreadHistory.ts";

export interface AgentSessionCandidateTranscript {
  readonly filePath: string;
  readonly mtimeMs: number | null;
  readonly historyThread?: CodexHistoryThreadRef;
}

export function countCandidateThreadsInWindow(
  candidate: {
    readonly source: AgentSessionSource;
    readonly transcripts: ReadonlyArray<AgentSessionCandidateTranscript>;
  },
  cutoffMs: number,
  nowMs: number,
): number {
  const ids = new Set<string>();
  for (const transcript of candidate.transcripts) {
    if (
      transcript.mtimeMs === null ||
      transcript.mtimeMs < cutoffMs ||
      transcript.mtimeMs > nowMs
    ) {
      continue;
    }
    ids.add(
      transcript.historyThread?.id ??
        (candidate.source === "codex"
          ? codexThreadIdFromRolloutPath(transcript.filePath)
          : undefined) ??
        transcript.filePath,
    );
  }
  return ids.size;
}
