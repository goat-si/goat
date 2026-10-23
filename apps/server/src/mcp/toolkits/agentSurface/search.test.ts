import { describe, expect, it } from "@effect/vitest";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";

import { search } from "./handlers.ts";

describe("goat_describe search", () => {
  it("finds a path by words only its guide holds", () => {
    const send = agentSurfaceRegistry["thread.send"];
    const withGuide = { ...send, guide: "Queued messages wait behind a running turn." };
    expect(search([withGuide], "queued behind").map((entry) => entry.path)).toEqual([
      "thread.send",
    ]);
    expect(search([send], "queued behind")).toEqual([]);
  });
});
