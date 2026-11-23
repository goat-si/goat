import * as Schema from "effect/Schema";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as CloudSource from "../CloudTaskSourceService.ts";
import { ProviderTurnStartError } from "../ProviderTurnStartTypes.ts";

export const isProviderTurnStartError = Schema.is(ProviderTurnStartError);
export const isCloudTaskSourceError = Schema.is(CloudSource.CloudTaskSourceError);
export const isProviderAdapterOpenSessionError = Schema.is(
  ProviderAdapter.ProviderAdapterOpenSessionError,
);

export function hasUnknownProviderOutcome(error: unknown): boolean {
  const seen = new Set<object>();
  while (typeof error === "object" && error !== null && !seen.has(error)) {
    seen.add(error);
    if ("category" in error && error.category === "request-deadline") return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}
