import type { ProviderInstanceId } from "@goat/contracts";
import type { TranscriptIdentity } from "./AgentSessionTranscriptIdentity.ts";

export interface TranscriptCandidate {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly homePath: string;
  readonly identity: TranscriptIdentity;
}
