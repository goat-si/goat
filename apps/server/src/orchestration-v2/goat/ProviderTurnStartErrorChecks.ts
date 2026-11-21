import * as Schema from "effect/Schema";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as CloudSource from "../CloudTaskSourceService.ts";
import { ProviderTurnStartError } from "../ProviderTurnStartTypes.ts";

export const isProviderTurnStartError = Schema.is(ProviderTurnStartError);
export const isCloudTaskSourceError = Schema.is(CloudSource.CloudTaskSourceError);
export const isProviderAdapterOpenSessionError = Schema.is(
  ProviderAdapter.ProviderAdapterOpenSessionError,
);
