import { describe, expect, it } from "vite-plus/test";
import { decidePenGatewayRequest } from "./penGatewayPolicy.ts";

const capability = "a".repeat(43);
const route = { capability, pin: "member" };
const request = (overrides: Record<string, unknown> = {}) => ({
  method: "GET",
  url: `/pen-route/${capability}/api/projects`,
  headers: { host: "127.0.0.1:1234", origin: "goat://app" },
  rawHeaders: ["Host", "127.0.0.1:1234", "Origin", "goat://app"],
  port: 1234,
  appOrigins: ["goat://app"],
  routes: [route],
  ...overrides,
});

describe("Pen gateway request policy", () => {
  it("refuses wrong capability, host and origin before forwarding", () => {
    expect(
      decidePenGatewayRequest(request({ url: `/pen-route/${"b".repeat(43)}/api/projects` })),
    ).toMatchObject({ kind: "refuse", status: 404, headers: { "referrer-policy": "no-referrer" } });
    expect(
      decidePenGatewayRequest(request({ headers: { host: "evil:1234", origin: "goat://app" } }))
        .kind,
    ).toBe("refuse");
    expect(
      decidePenGatewayRequest(
        request({ headers: { host: "127.0.0.1:1234", origin: "https://evil.example" } }),
      ).kind,
    ).toBe("refuse");
  });

  it("requires an app origin except for asset GET and HEAD", () => {
    const headers = { host: "127.0.0.1:1234" };
    expect(decidePenGatewayRequest(request({ headers })).kind).toBe("refuse");
    const asset = decidePenGatewayRequest(
      request({ headers, url: `/pen-route/${capability}/api/assets/a/b` }),
    );
    expect(asset.kind).toBe("forward");
    if (asset.kind === "forward") expect(asset.responseHeaders.vary).toBe("Origin");
    expect(
      decidePenGatewayRequest(
        request({ headers, method: "POST", url: `/pen-route/${capability}/api/assets/a/b` }),
      ).kind,
    ).toBe("refuse");
  });

  it("rejects credentials, session minting and path traversal", () => {
    for (const url of [
      `/pen-route/${capability}/api/pen/session`,
      `/pen-route/${capability}/api/pen/session;x`,
      `/pen-route/${capability}//api/pen/session`,
      `/pen-route/${capability}/API/pen/session`,
      `/pen-route/${capability}/api/pen/%73ession?x=1`,
      `/pen-route/${capability}/api/../ws`,
      `/pen-route/${capability}/api/%2e%2e/ws`,
    ]) {
      expect(decidePenGatewayRequest(request({ url })).kind).toBe("refuse");
    }
    for (const header of ["authorization", "dpop"]) {
      expect(
        decidePenGatewayRequest(
          request({
            headers: { host: "127.0.0.1:1234", origin: "goat://app", [header]: "secret" },
          }),
        ).kind,
      ).toBe("refuse");
    }
  });

  it("drops cookies and non-allowlisted headers while preserving approved fields", () => {
    const decision = decidePenGatewayRequest(
      request({
        headers: {
          host: "127.0.0.1:1234",
          origin: "goat://app",
          cookie: "secret",
          accept: "application/json",
          "x-other": "no",
        },
      }),
    );
    expect(decision.kind).toBe("forward");
    if (decision.kind === "forward")
      expect(decision.headers).toEqual({ accept: "application/json" });
  });

  it("drops fields nominated by Connection even when otherwise allowlisted", () => {
    const decision = decidePenGatewayRequest(
      request({
        headers: {
          host: "127.0.0.1:1234",
          origin: "goat://app",
          connection: "keep-alive, range",
          range: "bytes=0-1",
          accept: "text/plain",
        },
      }),
    );
    expect(decision.kind).toBe("forward");
    if (decision.kind === "forward") expect(decision.headers).toEqual({ accept: "text/plain" });
  });

  it("answers valid preflight without forwarding forbidden requested headers", () => {
    const decision = decidePenGatewayRequest(
      request({
        method: "OPTIONS",
        headers: {
          host: "127.0.0.1:1234",
          origin: "goat://app",
          "access-control-request-headers": "content-type, authorization, cookie, dpop",
          "access-control-request-private-network": "true",
        },
      }),
    );
    expect(decision.kind).toBe("preflight");
    if (decision.kind === "preflight") {
      expect(decision.headers["access-control-allow-headers"]).toBe("content-type");
      expect(decision.headers["access-control-allow-private-network"]).toBe("true");
    }
  });

  it("rejects transfer encoding and POST without a content length", () => {
    expect(decidePenGatewayRequest(request({ method: "POST" }))).toMatchObject({
      kind: "refuse",
      status: 411,
    });
    expect(
      decidePenGatewayRequest(
        request({
          headers: { host: "127.0.0.1:1234", origin: "goat://app", "transfer-encoding": "chunked" },
        }),
      ),
    ).toMatchObject({ kind: "refuse", status: 411 });
  });

  it("never forwards websocket compression and requires a valid upgrade", () => {
    const headers = {
      host: "127.0.0.1:1234",
      origin: "goat://app",
      upgrade: "websocket",
      "sec-websocket-key": "key",
      "sec-websocket-version": "13",
      "sec-websocket-extensions": "permessage-deflate",
    };
    const decision = decidePenGatewayRequest(request({ upgrade: true, headers }));
    expect(decision.kind).toBe("upgrade");
    if (decision.kind === "upgrade")
      expect(decision.headers).toEqual({
        "sec-websocket-key": "key",
        "sec-websocket-version": "13",
      });
    expect(
      decidePenGatewayRequest(request({ upgrade: true, headers: { ...headers, upgrade: "other" } }))
        .kind,
    ).toBe("refuse");
  });

  it("rejects duplicate security-sensitive headers", () => {
    expect(
      decidePenGatewayRequest(
        request({ rawHeaders: ["Host", "127.0.0.1:1234", "Host", "evil", "Origin", "goat://app"] }),
      ).kind,
    ).toBe("refuse");
  });
});
