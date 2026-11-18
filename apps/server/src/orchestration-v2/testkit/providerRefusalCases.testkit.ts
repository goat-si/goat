import { ProviderDriverKind } from "@goat/contracts";
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
] as const;
