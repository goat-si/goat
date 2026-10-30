import { describe, expect, it } from "vitest";
import { deniedCallApp } from "./ComputerUseCallSafety.ts";

describe("computer use call safety", () => {
  it("refuses organization-denied apps and batch scopes", () => {
    const denied = ["com.example.Blocked"];
    expect(deniedCallApp({ name: "click", args: {}, app: "COM.EXAMPLE.BLOCKED" }, denied)).toBe(
      "COM.EXAMPLE.BLOCKED",
    );
    expect(
      deniedCallApp(
        {
          name: "run_script",
          args: { app_scope: { apps: ["com.example.Blocked"], delivery: "background" } },
        },
        denied,
      ),
    ).toBe("com.example.Blocked");
    expect(
      deniedCallApp({ name: "click", args: {}, app: "com.example.Good" }, denied),
    ).toBeUndefined();
  });
});
