const PEN_ROUTE_PATH = /^\/pen-route\/[A-Za-z0-9_-]{43}(?=\/|$)/u;

/** The path prefix of a Pen route; only the desktop's loopback gateway serves one. */
export const penRoutePrefix = (url: URL): string | undefined =>
  (url.protocol === "http:" || url.protocol === "ws:") && url.hostname === "127.0.0.1"
    ? url.pathname.match(PEN_ROUTE_PATH)?.[0]
    : undefined;

export const isPenRouteUrl = (input: string | URL): boolean => {
  try {
    return penRoutePrefix(new URL(input)) !== undefined;
  } catch {
    return false;
  }
};

/** Replaces the capability of every Pen route path in the text, so it can be logged or stored. */
export const redactPenRouteUrl = (input: string): string =>
  input.replace(/(\/pen-route\/)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu, "$1redacted");
