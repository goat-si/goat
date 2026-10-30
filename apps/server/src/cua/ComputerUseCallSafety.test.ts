import { describe, expect, it } from "@effect/vitest";
import { deniedCallApp } from "./ComputerUseCallSafety.ts";

describe("computer use call safety", () => {
  it("refuses terminal for non-person full access but allows a person's terminal", () => {
    const call = { name: "click", args: {}, app: "com.apple.Terminal" };
    expect(deniedCallApp(call, [], true)).toBe("com.apple.Terminal");
    expect(deniedCallApp(call, [], false)).toBeUndefined();
  });
  it("refuses organization-denied apps and batch scopes", () => {
    const denied = ["com.example.Blocked"];
    expect(deniedCallApp({ name: "click", args: {}, app: "COM.EXAMPLE.BLOCKED" }, denied)).toBe(
      "COM.EXAMPLE.BLOCKED",
    );
    expect(
      deniedCallApp(
        { name: "click", args: {}, app: "/example/editor", safetyApps: ["com.example.Blocked"] },
        denied,
      ),
    ).toBe("com.example.Blocked");
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
