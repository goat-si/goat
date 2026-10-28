import { describe, expect, it } from "vite-plus/test";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import { ScreenRunTool, validScreenRunPayload } from "./tools.ts";

describe("screen run tool input", () => {
  it("rejects caller identity and target authority outside the bounded cell input", () => {
    expect(validScreenRunPayload({ code: "return 1", runId: "forged" })).toBe(false);
    expect(validScreenRunPayload({ code: "return 1", bindingHints: { tabs: [] } })).toBe(false);
  });

  it("allows lowered limits and refuses raised or unknown limits", () => {
    expect(validScreenRunPayload({ code: "return 1", limits: { callsPerCell: 2 } })).toBe(true);
    expect(validScreenRunPayload({ code: "return 1", limits: { callsPerCell: 1000 } })).toBe(false);
    expect(validScreenRunPayload({ code: "return 1", limits: { extra: 1 } })).toBe(false);
  });

  it("takes a one-line title of at most 80 characters, and says so where agents read the input", () => {
    expect(validScreenRunPayload({ code: "return 1", title: "Terminal: run the tests" })).toBe(
      true,
    );
    for (const title of ["", "two\nlines", "carriage\rreturn", "x".repeat(81), 3])
      expect(validScreenRunPayload({ code: "return 1", title })).toBe(false);
    // The schema, the guide and validation ship in one build, so no agent learns of title from a
    // server that refuses it.
    expect(JSON.stringify(advertisedJsonSchema(ScreenRunTool))).toContain('"title"');
    expect(agentSurfaceRegistry["surface.screen_run"].guide).toContain("title?:string");
  });
});
