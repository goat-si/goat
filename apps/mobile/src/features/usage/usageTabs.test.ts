import { describe, expect, it } from "vite-plus/test";

import { resolveUsageTab, showsFleetTab, usageTabOptions } from "./usageTabs";

const env = (enabled: boolean, connected: boolean, hubEnabled = false) => ({
  enabled,
  connected,
  hubEnabled,
});

describe("showsFleetTab", () => {
  it("shows Fleet once the phone reaches more than one server, connected or not", () => {
    expect(showsFleetTab([env(true, true)])).toBe(false);
    expect(showsFleetTab([env(true, true), env(true, false)])).toBe(true);
    // A hub's devices are environments of their own, so a hub pairing with devices counts them.
    expect(showsFleetTab([env(true, true), env(true, true), env(true, true)])).toBe(true);
  });

  it("leaves out servers switched off in Connections", () => {
    expect(showsFleetTab([env(true, true), env(false, false)])).toBe(false);
  });

  it("shows Fleet for a connected hub even before its devices open on this phone", () => {
    expect(showsFleetTab([env(true, true, true)])).toBe(true);
    expect(showsFleetTab([env(true, false, true)])).toBe(false);
  });
});

describe("usage tabs", () => {
  it("puts Fleet first when it shows and keeps Usage | Limits otherwise", () => {
    expect(usageTabOptions(true).map((option) => option.value)).toEqual([
      "fleet",
      "usage",
      "limits",
    ]);
    expect(usageTabOptions(false).map((option) => option.value)).toEqual(["usage", "limits"]);
  });

  it("opens Fleet by default when it shows, and Limits as before when it does not", () => {
    expect(resolveUsageTab({ choice: null, param: undefined, fleetVisible: true })).toBe("fleet");
    expect(resolveUsageTab({ choice: null, param: undefined, fleetVisible: false })).toBe("limits");
  });

  it.each([
    ["usage", true, "usage"],
    ["limits", true, "limits"],
    ["fleet", true, "fleet"],
    ["usage", false, "usage"],
    ["limits", false, "limits"],
    // A Fleet link on a phone that reaches one server opens the screen it would otherwise show.
    ["fleet", false, "limits"],
    ["unknown", true, "fleet"],
  ] as const)("deep link tab=%s with Fleet shown %s opens %s", (param, fleetVisible, tab) => {
    expect(resolveUsageTab({ choice: null, param, fleetVisible })).toBe(tab);
  });

  it("keeps the person's pick over the link, and returns to Fleet once it shows again", () => {
    expect(resolveUsageTab({ choice: "usage", param: "fleet", fleetVisible: true })).toBe("usage");
    expect(resolveUsageTab({ choice: "fleet", param: undefined, fleetVisible: false })).toBe(
      "limits",
    );
    expect(resolveUsageTab({ choice: "fleet", param: undefined, fleetVisible: true })).toBe(
      "fleet",
    );
  });
});
