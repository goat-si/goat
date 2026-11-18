// @effect-diagnostics nodeBuiltinImport:off -- Real loopback HTTP against the gateway under test.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "vite-plus/test";

import { makePenGateway } from "./PenGateway.ts";
import { fakeChild, pin } from "./penGateway.testkit.ts";

describe("Pen gateway session mint", () => {
  it("answers requests past the waiting limit at once while a mint is stalled", async () => {
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      // The member never answers the mint, so every private request waits for it.
      spawn: () => fakeChild(),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const agent = new NodeHttp.Agent({ keepAlive: false, maxSockets: Infinity });
      const statuses: Array<number> = [];
      const refused = new Promise<void>((resolve) => {
        for (let index = 0; index < 40; index++) {
          const req = NodeHttp.request(`${route.httpBaseUrl}/api/projects`, {
            agent,
            headers: { origin: "goat://app" },
          });
          req.on("response", (res) => {
            statuses.push(res.statusCode ?? 0);
            res.resume();
            if (statuses.length === 40 - 32) resolve();
          });
          req.on("error", () => {});
          req.end();
        }
      });
      await refused;
      expect(statuses).toEqual(Array.from({ length: 8 }, () => 503));
      agent.destroy();
    } finally {
      await gateway.dispose();
    }
  });
});
