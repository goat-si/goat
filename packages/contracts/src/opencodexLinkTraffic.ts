import * as Schema from "effect/Schema";

import { ForwardCompatibleOptional } from "./baseSchemas.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Body bytes the Home counted on one link in a trailing window. Bytes cross only between two
 * readings of the same OpenCodex counter (same epoch and generation); measuredMs is how much of
 * the window those readings span, so a short measurement reads as one.
 */
export const OpenCodexLinkTrafficWindow = Schema.Struct({
  toHomeBytes: Count,
  fromHomeBytes: Count,
  /** Of those, bytes measured while both readings had the same Pen relay route in use. */
  relayToHomeBytes: Count,
  relayFromHomeBytes: Count,
  /** Of those, bytes measured while both readings had the same direct route in use. */
  directToHomeBytes: Count,
  directFromHomeBytes: Count,
  measuredMs: Count,
  /** Time in the window between readings more than five minutes apart; their bytes are averaged. */
  averagedMs: Schema.optional(Count),
  /** Requests whose body bytes OpenCodex could not count, so toHomeBytes is a lower bound. */
  uncountedRequests: Schema.optional(Count),
});
export type OpenCodexLinkTrafficWindow = typeof OpenCodexLinkTrafficWindow.Type;

export const OpenCodexLinkTraffic = Schema.Struct({
  hour: OpenCodexLinkTrafficWindow,
  day: OpenCodexLinkTrafficWindow,
  /** A link WebSocket was open: only relayed HTTP bodies are counted, so the figures are lower bounds. */
  httpBodiesOnly: ForwardCompatibleOptional(Schema.Literal(true)),
  /** Relay bytes both ways in the last 24 hours reached the Home's per-device threshold. */
  warning: ForwardCompatibleOptional(Schema.Struct({ thresholdBytes: Count })),
});
export type OpenCodexLinkTraffic = typeof OpenCodexLinkTraffic.Type;

/**
 * The route the link's proven tunnel uses. via is relay when the name is a Host in Pen's ssh
 * config on the Home and direct otherwise; absent when that config could not be read.
 */
export const OpenCodexLinkRoute = Schema.Struct({
  name: Schema.String,
  via: ForwardCompatibleOptional(Schema.Literals(["relay", "direct"])),
  /** When the Home proved it, for a link with several routes. */
  since: ForwardCompatibleOptional(Schema.Number),
});
export type OpenCodexLinkRoute = typeof OpenCodexLinkRoute.Type;

/** websocket while a link WebSocket is open, else http. */
export const OpenCodexLinkTransport = Schema.Literals(["http", "websocket"]);
export type OpenCodexLinkTransport = typeof OpenCodexLinkTransport.Type;

/** Relay bytes over every link in the last 24 hours reached the Home's per-hub threshold. */
export const OpenCodexHubRelayWarning = Schema.Struct({ relayBytes: Count, thresholdBytes: Count });
export type OpenCodexHubRelayWarning = typeof OpenCodexHubRelayWarning.Type;

/** The fields a Home's GOAT adds to each link row; each is absent when OpenCodex does not report it. */
export const OpenCodexLinkTrafficFields = {
  traffic: ForwardCompatibleOptional(OpenCodexLinkTraffic),
  route: ForwardCompatibleOptional(OpenCodexLinkRoute),
  transport: ForwardCompatibleOptional(OpenCodexLinkTransport),
};
