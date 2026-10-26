import { describe, expect, it } from "vite-plus/test";
import { validScreenRunPayload } from "./tools.ts";

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
});
