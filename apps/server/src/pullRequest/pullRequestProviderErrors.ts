import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  type SourceControlProviderKind,
} from "@goat/contracts";
import type {
  PullRequestProviderApi,
  PullRequestProviderError,
} from "@goat/source-control-core/server/PullRequestProvider";

import type { PullRequestError } from "./PullRequestService.ts";

export function isProviderUnusable(error: PullRequestProviderError): boolean {
  return error.reason === "missing-tool" || error.reason === "unauthenticated";
}

export type UnavailableRequirementOf = (
  kind: SourceControlProviderKind,
) => PullRequestProviderApi["unavailableRequirement"];

function unavailableRequirement(
  requirementOf: UnavailableRequirementOf,
  error: PullRequestProviderError,
): string | undefined {
  const requirement = requirementOf(error.provider);
  if (requirement === undefined) return undefined;
  return error.reason === "missing-tool" ? requirement.missing : requirement.unauthenticated;
}

export function providerDetail(
  requirementOf: UnavailableRequirementOf,
  error: PullRequestProviderError,
): string {
  if (!isProviderUnusable(error)) return error.detail;
  return unavailableRequirement(requirementOf, error) ?? error.detail;
}

export function toUnavailableError(error: PullRequestProviderError): PullRequestUnavailableError {
  return new PullRequestUnavailableError({
    reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
    provider: error.provider,
    cause: error,
  });
}

export function toPullRequestErrorWith(
  requirementOf: UnavailableRequirementOf,
): (operation: string) => (error: PullRequestProviderError) => PullRequestError {
  return (operation) => (error) => {
    if (isProviderUnusable(error)) {
      const requirement = unavailableRequirement(requirementOf, error);
      return new PullRequestUnavailableError({
        reason: error.reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
        provider: error.provider,
        ...(requirement === undefined ? {} : { requirement }),
        cause: error,
      });
    }
    return new PullRequestOperationError({
      operation,
      detail: error.detail,
      ...(error.reason === "not-found" ? { reason: "not-found" as const } : {}),
      cause: error,
    });
  };
}
