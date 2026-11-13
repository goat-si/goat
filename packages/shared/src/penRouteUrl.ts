export const PEN_ROUTE_PATH = /^\/pen-route\/[A-Za-z0-9_-]{43}(?=\/|$)/u;

export const isPenRouteUrl = (input: string | URL): boolean => {
  try {
    return PEN_ROUTE_PATH.test(new URL(input).pathname);
  } catch {
    return false;
  }
};

/** Replaces the capability of every Pen route path in the text, so it can be logged or stored. */
export const redactPenRouteUrl = (input: string): string =>
  input.replace(/(\/pen-route\/)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu, "$1redacted");
