import { describe, expect, it } from "vite-plus/test";

import { webhookAddress } from "./webhookAddress.ts";

const path = "/api/hooks/scheduled-task%3Ahook/token";
const endpoint = (url: string | null) => ({ path, url, hasSecret: false });

describe("webhookAddress", () => {
  it("builds a direct URL on the environment's address without GOAT Connect", () => {
    const result = webhookAddress(endpoint(null), "https://mac.tail1234.ts.net/");
    expect(result.address).toBe(`https://mac.tail1234.ts.net${path}`);
    expect(result.copyable).toBe(true);
    expect(result.note).toContain("Tailscale");
    expect(result.note).toContain("GOAT Connect (coming soon)");
    expect(result.note).not.toContain("GOAT Connect");
  });

  it("falls back to the path when the address is unknown", () => {
    expect(webhookAddress(endpoint(null), null)).toMatchObject({
      address: path,
      copyable: false,
      note: "Public URLs arrive with GOAT Connect (coming soon).",
    });
  });
});
