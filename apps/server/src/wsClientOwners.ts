import { isTelemetryIdHash } from "@goat/shared/telemetryId";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import { requestUrl } from "./requestUrl.ts";
import type { TelemetryOwner } from "./telemetry/Identify.ts";

/**
 * Owners a connecting client reports: its hashed GOAT Connect account and its
 * hashed device id. Only hashes are accepted, so a raw id never reaches analytics.
 */
export function readClientOwners(
  request: HttpServerRequest.HttpServerRequest,
): ReadonlyArray<TelemetryOwner> {
  const url = requestUrl(request);
  if (Option.isNone(url)) {
    return [];
  }
  const params = url.value.searchParams;
  return (
    [
      ["connect", params.get("clientOwner")],
      ["device", params.get("clientDevice")],
    ] as const
  ).flatMap(([source, ownerId]) =>
    ownerId !== null && isTelemetryIdHash(ownerId) ? [{ source, ownerId }] : [],
  );
}
