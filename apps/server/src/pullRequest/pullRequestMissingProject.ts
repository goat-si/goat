import { PullRequestUnavailableError } from "@goat/contracts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import type { PullRequestProviderRegistry } from "./PullRequestProviderRegistry.ts";

export function missingProjectError(
  host: string,
  referenceKey: string,
  registry: PullRequestProviderRegistry["Service"],
) {
  const owner =
    sourceControlDefinitions.findByPublicHost(host) ??
    sourceControlDefinitions.findByRepositoryKey(referenceKey);
  const provider = owner === undefined ? null : registry.get(owner.kind);
  if (
    provider !== null &&
    !provider.readsPublicHostWithoutCheckout &&
    provider.servesHost?.(host) !== false
  ) {
    return new PullRequestUnavailableError({
      reason: "provider-unsupported",
      detail: provider.repositoryKey === undefined ? "no-project-on-host" : "repository-not-added",
    });
  }
  return new PullRequestUnavailableError({ reason: "provider-unsupported" });
}
