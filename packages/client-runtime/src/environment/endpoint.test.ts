import { describe, expect, it, vi } from "vite-plus/test";

import {
  deriveWsBaseUrl,
  normalizeHttpBaseUrl,
  environmentEndpointUrl,
  environmentRoutePrefix,
} from "./endpoint.ts";
import { resolveAssetUrl } from "../state/assets.ts";
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";

// These cases are the open viewer's; a closed one recognizes no Pen route URL.
vi.mock("@goat/shared/penViewerGate", () => ({ PEN_VIEWER_ENABLED: true }));

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });
});

describe("Pen route URL builders", () => {
  const capability = "a".repeat(43);
  const prefix = `/pen-route/${capability}`;
  const base = `http://127.0.0.1:3333${prefix}/`;

  it("preserves the capability for descriptor, HTTP API, assets and socket prefix", () => {
    expect(environmentEndpointUrl(base, "/.well-known/goat/environment")).toBe(
      `http://127.0.0.1:3333${prefix}/.well-known/goat/environment`,
    );
    expect(makeEnvironmentHttpApiUrlBuilder(base).auth.session()).toBe(
      `http://127.0.0.1:3333${prefix}/api/auth/session`,
    );
    expect(resolveAssetUrl(base, "/api/assets/thread/asset")).toBe(
      `http://127.0.0.1:3333${prefix}/api/assets/thread/asset`,
    );
    expect(environmentRoutePrefix(new URL(`${base}ws`))).toBe(prefix);
  });

  it("accepts exactly 43 base64url characters and preserves hub prefixes", () => {
    expect(environmentRoutePrefix(new URL(`http://127.0.0.1/pen-route/${"_".repeat(43)}`))).toBe(
      `/pen-route/${"_".repeat(43)}`,
    );
    for (const length of [42, 44]) {
      expect(
        environmentRoutePrefix(new URL(`http://127.0.0.1/pen-route/${"a".repeat(length)}/ws`)),
      ).toBe("");
    }
    expect(environmentRoutePrefix(new URL(`http://127.0.0.1/other${prefix}/ws`))).toBe("");
    // Only the desktop's loopback gateway serves Pen routes; a hub deployment keeps its node path.
    expect(environmentRoutePrefix(new URL(`https://hub.example.test${prefix}/ws`))).toBe("");
    expect(environmentEndpointUrl(`https://hub.example.test${prefix}/hub/nodes/n/`, "/api/x")).toBe(
      `https://hub.example.test${prefix}/hub/nodes/n/api/x`,
    );
    expect(environmentRoutePrefix(new URL("http://localhost/deploy/hub/nodes/node-1/api"))).toBe(
      "/deploy/hub/nodes/node-1",
    );
  });
});
