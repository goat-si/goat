import { describe, expect, it } from "@effect/vitest";

import { admitPenRequest } from "./penRoutes.ts";

const bearer = { authorization: "Bearer token-1" };
const admit = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
  upgrade = false,
) => admitPenRequest({ method, url, upgrade, headers });
const kind = (admission: ReturnType<typeof admit>) =>
  admission.kind === "admit" ? "admit" : admission.status;

describe("Pen route table, default deny (mesh link design §5)", () => {
  it("admits exactly the listed routes, as the hub proxy calls them", () => {
    expect(kind(admit("GET", "/.well-known/goat/environment"))).toBe("admit");
    expect(kind(admit("HEAD", "/.well-known/goat/environment"))).toBe("admit");
    expect(kind(admit("GET", "/.well-known/t3/environment"))).toBe("admit"); // goat-rename: legacy
    expect(kind(admit("HEAD", "/.well-known/t3/environment"))).toBe("admit"); // goat-rename: legacy
    expect(kind(admit("POST", "/api/pen/session"))).toBe("admit");
    expect(kind(admit("POST", "/mcp", bearer))).toBe("admit");
    expect(kind(admit("GET", "/mcp", bearer))).toBe("admit");
    expect(kind(admit("POST", "/api/attachments/upload/abc.def", bearer))).toBe("admit");
    expect(kind(admit("GET", "/api/orchestration/shell?bounded=1", bearer))).toBe("admit");
    expect(kind(admit("GET", "/api/orchestration/threads/thread%3Aa%3Ab/history", bearer))).toBe(
      "admit",
    );
    expect(kind(admit("HEAD", "/api/projects", bearer))).toBe("admit");
    expect(kind(admit("GET", "/api/assets/token/file%20name.png", bearer))).toBe("admit");
    expect(
      kind(
        admit(
          "GET",
          "/ws?orchestrationProtocol=2&clientSurface=web&clientSurface=web",
          { ...bearer, upgrade: "websocket" },
          true,
        ),
      ),
    ).toBe("admit");
  });

  it("refuses everything else with 404 before any handler", () => {
    for (const [method, url] of [
      ["GET", "/api/auth/session"],
      ["POST", "/api/auth/ws-ticket"],
      ["GET", "/api/orchestration/threads/a/b/c"],
      ["OPTIONS", "/mcp"],
      ["PUT", "/mcp"],
      ["DELETE", "/api/projects"],
      ["GET", "/api/runtime/session"],
      ["GET", "/api/preview/x"],
      ["GET", "http://evil/mcp"],
      ["GET", "*"],
      ["GET", "/mcp/"],
      ["GET", "//mcp"],
      ["GET", "/api/orchestration/threads/../shell"],
      ["GET", "/api/orchestration/threads/./shell"],
      ["GET", "/api/orchestration/threads/a%2Fb"],
      ["GET", "/api/orchestration/threads/a%2fb"],
      ["GET", "/api/orchestration/threads/%2e%2e"],
      ["GET", "/api/orchestration/threads/a%5Cb"],
      ["GET", "/api/orchestration/threads/a%00"],
      ["GET", "/api/orchestration/threads/a\\b"],
      ["GET", "/api/pen/session"],
    ] as const)
      expect(kind(admit(method, url, bearer)), `${method} ${url}`).toBe(404);
  });

  it("refuses credentials in queries, unknown socket parameters and queries where none belong", () => {
    expect(kind(admit("GET", "/api/orchestration/shell?token=x", bearer))).toBe(404);
    expect(kind(admit("GET", "/api/orchestration/shell?%77sTicket=x", bearer))).toBe(404);
    expect(kind(admit("GET", "/ws?wsTicket=x", { ...bearer, upgrade: "websocket" }, true))).toBe(
      404,
    );
    expect(kind(admit("GET", "/ws?debug=1", { ...bearer, upgrade: "websocket" }, true))).toBe(404);
    expect(kind(admit("POST", "/mcp?x=1", bearer))).toBe(404);
    expect(kind(admit("POST", "/api/pen/session?x=1"))).toBe(404);
  });

  it("needs one bearer and no cookie on credentialed rows, and no credential on open ones", () => {
    expect(kind(admit("POST", "/mcp"))).toBe(401);
    expect(kind(admit("POST", "/mcp", { authorization: "DPoP token-1" }))).toBe(401);
    expect(kind(admit("POST", "/mcp", { authorization: "Bearer a, Bearer b" }))).toBe(401);
    expect(kind(admit("POST", "/mcp", { ...bearer, cookie: "session=x" }))).toBe(404);
    expect(kind(admit("POST", "/mcp", { ...bearer, dpop: "proof" }))).toBe(404);
    expect(kind(admit("POST", "/api/pen/session", bearer))).toBe(404);
    expect(kind(admit("GET", "/ws", bearer, false))).toBe(404);
    expect(kind(admit("POST", "/mcp", { ...bearer, upgrade: "websocket" }, true))).toBe(404);
  });
});
