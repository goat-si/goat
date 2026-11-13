import { describe, expect, it } from "@effect/vitest";
import { isPenRouteUrl, redactPenRouteUrl } from "./penRouteUrl.ts";

describe("Pen route URLs", () => {
  const capability = "a".repeat(43);
  const url = `http://127.0.0.1:1234/pen-route/${capability}/api`;
  it("recognizes only a complete capability path at the start", () => {
    expect(isPenRouteUrl(url)).toBe(true);
    expect(isPenRouteUrl(new URL(url))).toBe(true);
    expect(isPenRouteUrl(`http://localhost/pen-route/${capability}a/`)).toBe(false);
    expect(isPenRouteUrl(`http://localhost/x/pen-route/${capability}/`)).toBe(false);
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
