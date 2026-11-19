import { describe, expect, it } from "@effect/vitest";
import { isPenRouteUrl, redactPenRouteUrl } from "./penRouteUrl.ts";

describe("Pen route URLs", () => {
  const capability = "a".repeat(43);
  const url = `http://127.0.0.1:1234/pen-route/${capability}/api`;
  const open = { enabled: true };
  it("recognizes only a complete capability path at the start", () => {
    expect(isPenRouteUrl(url, open)).toBe(true);
    expect(isPenRouteUrl(new URL(url), open)).toBe(true);
    expect(isPenRouteUrl(`http://localhost/pen-route/${capability}a/`, open)).toBe(false);
    expect(isPenRouteUrl(`http://localhost/x/pen-route/${capability}/`, open)).toBe(false);
    expect(isPenRouteUrl(`ws://127.0.0.1:1234/pen-route/${capability}/ws`, open)).toBe(true);
  });
  it("is only the desktop's loopback gateway: a hub deployment with the same path is not", () => {
    expect(isPenRouteUrl(`https://hub.example/pen-route/${capability}/hub/nodes/n/`, open)).toBe(
      false,
    );
    expect(isPenRouteUrl(`https://127.0.0.1/pen-route/${capability}/`, open)).toBe(false);
    expect(isPenRouteUrl(`http://localhost:1234/pen-route/${capability}/`, open)).toBe(false);
  });
  it("is no URL at all while the viewer is closed, so a local service with that path works as before", () => {
    expect(isPenRouteUrl(url, { enabled: false })).toBe(false);
    expect(isPenRouteUrl(url)).toBe(false);
  });
  it("redacts capabilities in embedded URLs without changing other text", () => {
    expect(redactPenRouteUrl(`failed ${url}: error`)).toBe(
      `failed http://127.0.0.1:1234/pen-route/redacted/api: error`,
    );
    expect(redactPenRouteUrl("not a URL")).toBe("not a URL");
    expect(redactPenRouteUrl(`http://localhost/pen-route/${capability}a/`)).toBe(
      `http://localhost/pen-route/${capability}a/`,
    );
  });
});
