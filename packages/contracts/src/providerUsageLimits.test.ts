import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";

const decodeWindow = Schema.decodeSync(ServerProviderUsageWindow);
const encodeWindow = Schema.encodeSync(ServerProviderUsageWindow);

const olderWindow = {
  id: "budget",
  kind: "monthly",
  label: "Monthly budget",
  usedPercent: 40,
} as const;

// The window as peers decoded it before per-model scopes existed.
const OlderPeerUsageWindow = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: Schema.String,
  usedPercent: Schema.Number,
});

const decodeOlderWindow = Schema.decodeSync(OlderPeerUsageWindow);

describe("ServerProviderUsageWindow model scopes", () => {
  it("decodes a window from an older peer without scopes", () => {
    const decoded = decodeWindow(olderWindow);
    expect(decoded.modelIds).toBeUndefined();
    expect(decoded.providerIds).toBeUndefined();
  });

  it("lets an older peer decode a scoped window as an unscoped one", () => {
    const scoped = encodeWindow({
      ...olderWindow,
      modelIds: ["opencode/limited"],
      providerIds: ["opencode"],
    });
    expect(decodeOlderWindow(scoped)).toEqual(olderWindow);
  });

  it("rejects a blank model scope", () => {
    expect(() => decodeWindow({ ...olderWindow, modelIds: [" "] })).toThrow();
  });
});
