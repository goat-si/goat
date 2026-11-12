import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ChildReadyConnectionResult } from "./opencodexChildReady.ts";

// The result as Homes before OpenCodex messages decoded it.
const OlderResult = Schema.Struct({
  destinationEnvironmentId: Schema.String,
  homeEnvironmentId: Schema.String,
  operationId: Schema.String,
  kind: Schema.Literals(["connectHubClient", "disconnect", "restart"]),
  code: Schema.Int,
  healthy: Schema.Boolean,
  role: Schema.optional(Schema.Literals(["standalone", "hub", "client", "unknown"])),
});

const decodeResult = Schema.decodeUnknownSync(ChildReadyConnectionResult);
const decodeOlder = Schema.decodeUnknownSync(OlderResult);

const answer = {
  destinationEnvironmentId: "child",
  homeEnvironmentId: "home",
  operationId: "op",
  kind: "restart",
  code: 1,
  healthy: true,
  role: "client",
};

describe("ChildReadyConnectionResult across versions", () => {
  it("carries OpenCodex's message from a newer Child, and an older Home still decodes it", () => {
    const newer = { ...answer, message: "client_catalog_ownership_changed" };
    expect(decodeResult(newer).message).toBe("client_catalog_ownership_changed");
    expect(decodeOlder(newer).code).toBe(1);
  });

  it("decodes an older Child's answer without a message", () => {
    expect(decodeResult(answer).message).toBeUndefined();
  });
});
