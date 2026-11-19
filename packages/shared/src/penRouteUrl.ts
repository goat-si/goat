import { PEN_VIEWER_ENABLED, type PenViewerPolicy } from "./penViewerGate.ts";

const PEN_ROUTE_PATH = /^\/pen-route\/[A-Za-z0-9_-]{43}(?=\/|$)/u;

/**
 * The path prefix of a Pen route; only the desktop's loopback gateway serves one, and only while
 * the viewer is open. While it is closed no URL is one, so every caller behaves as before Pen.
 */
export const penRoutePrefix = (
  url: URL,
  policy: PenViewerPolicy = { enabled: PEN_VIEWER_ENABLED },
): string | undefined =>
  policy.enabled &&
  (url.protocol === "http:" || url.protocol === "ws:") &&
  url.hostname === "127.0.0.1"
    ? url.pathname.match(PEN_ROUTE_PATH)?.[0]
    : undefined;

export const isPenRouteUrl = (
  input: string | URL,
  policy: PenViewerPolicy = { enabled: PEN_VIEWER_ENABLED },
): boolean => {
  try {
    return penRoutePrefix(new URL(input), policy) !== undefined;
  } catch {
    return false;
  }
};

/** Replaces the capability of every Pen route path in the text, so it can be logged or stored. */
export const redactPenRouteUrl = (
  input: string,
  policy: PenViewerPolicy = { enabled: PEN_VIEWER_ENABLED },
): string =>
  policy.enabled
    ? input.replace(/(\/pen-route\/)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu, "$1redacted")
    : input;
