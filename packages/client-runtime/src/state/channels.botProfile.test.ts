import { describe, expect, it } from "vite-plus/test";

import { botProfileChanges } from "./channels.ts";

const initial = { name: "Helper", avatar: null, purpose: "", color: "#2F6FED" };
const draft = { name: "Helper", avatar: "", purpose: "" };

describe("botProfileChanges and a bot's color", () => {
  it("creates with a chosen color and without one when neutral or not offered", () => {
    expect(botProfileChanges("create", initial, { ...draft, color: "#0F8B8D" })).toHaveProperty(
      "color",
      "#0F8B8D",
    );
    expect(botProfileChanges("create", initial, { ...draft, color: null })).not.toHaveProperty(
      "color",
    );
    expect(botProfileChanges("create", initial, draft)).not.toHaveProperty("color");
  });

  it("edits send a changed color, null to clear it, and nothing for case or an absent picker", () => {
    expect(botProfileChanges("edit", initial, { ...draft, color: "#0F8B8D" })).toEqual({
      color: "#0F8B8D",
    });
    expect(botProfileChanges("edit", initial, { ...draft, color: null })).toEqual({ color: null });
    expect(botProfileChanges("edit", initial, { ...draft, color: "#2f6fed" })).toEqual({});
    expect(botProfileChanges("edit", initial, draft)).toEqual({});
  });
});
