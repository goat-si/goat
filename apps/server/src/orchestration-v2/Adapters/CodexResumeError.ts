export { forkCodexThread } from "../../provider/CodexFork.ts";
import { ProviderDriverKind, type ProviderSessionId, type ProviderThreadId } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

const isRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

export function codexResumeError(
  cause: unknown,
  providerSessionId: ProviderSessionId,
  providerThreadId: ProviderThreadId,
  normalizedCause: unknown,
) {
  if (
    isRequestError(cause) &&
    cause.code === -32600 &&
    cause.errorMessage.includes("already has an active writer")
  ) {
    return new ProviderAdapter.ProviderAdapterThreadInUseError({
      driver: ProviderDriverKind.make("codex"),
      providerThreadId,
      detail:
        "This conversation is open in another Codex client, such as the Codex app, the Codex CLI, or an IDE extension. Codex lets one client write to a conversation at a time. Quit that client, then send your message again.",
      cause,
    });
  }
  return new ProviderAdapter.ProviderAdapterResumeThreadError({
    driver: ProviderDriverKind.make("codex"),
    providerSessionId,
    providerThreadId,
    cause: normalizedCause,
  });
}
