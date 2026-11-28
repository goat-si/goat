import { ProviderDriverKind, ProviderThreadId, RunId, ThreadId } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";
import {
  ClaudeAgentSdkQueryRunnerError,
  ClaudeAppendSystemPromptFileError,
  ClaudeBackgroundWorkBlocksQueryReplacementError,
} from "../Adapters/ClaudeAdapterV2.ts";

class ClaudeMcpRegistrationTimeoutError extends Schema.TaggedError<ClaudeMcpRegistrationTimeoutError>()(
  "ClaudeMcpRegistrationTimeoutError",
  {},
) {}

export const refusalCases = [
  ["background work", new ClaudeBackgroundWorkBlocksQueryReplacementError()],
  [
    "a transport failure after the submit fence",
    new Error("Prompt acknowledgement was lost."),
    "ambiguous",
  ],
  [
    "background work after native history injection",
    new ClaudeBackgroundWorkBlocksQueryReplacementError(),
    "inject",
  ],
  [
    "background work followed by a lost native session",
    new ClaudeBackgroundWorkBlocksQueryReplacementError(),
    "lost",
  ],
  ["an unreadable append file", new ClaudeAppendSystemPromptFileError({ path: "missing.md" })],
  [
    "an MCP registration timeout",
    new ClaudeAgentSdkQueryRunnerError({
      method: "setMcpServers",
      cause: new ClaudeMcpRegistrationTimeoutError(),
    }),
  ],
  [
    "a resume point Claude rejects",
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: ProviderDriverKind.make("claudeAgent"),
      detail: "Claude provider query ended before the turn could start.",
    }),
  ],
  // ACP rejects a model it cannot select before sending the prompt.
  [
    "an ACP start that rejected the model",
    new ProviderAdapter.ProviderAdapterTurnStartError({
      driver: ProviderDriverKind.make("grok"),
      threadId: ThreadId.make("thread:acp-refused-start"),
      providerThreadId: ProviderThreadId.make("provider-thread:acp-refused-start"),
      runId: RunId.make("run:acp-refused-start"),
      refusedBeforePrompt: true,
    }),
  ],
] as const;
