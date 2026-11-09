import { describe, expect, it } from "vite-plus/test";

import {
  cuaDriverCapabilityManifest,
  cuaDriverManifestAllowsTool,
  cuaDriverManifestLaunchGrants,
} from "./cuaDriverManifest.ts";

const applications = ["com.apple.calculator", { executable: "/usr/bin/gedit", names: ["gedit"] }];
const invalid = "Invalid capability manifest launch grant.";

describe("cuaDriverManifest launch grants", () => {
  it("grants launch exactly once in every admitted app entry when launch_app is allowed, and never without it", () => {
    const text = cuaDriverCapabilityManifest({ applications });
    expect(text).toContain(
      [
        '    - bundle_id: "com.apple.calculator"',
        "      launch: true",
        '      terminate: "driver_launched"',
        '    - executable: "/usr/bin/gedit" # names: ["gedit"]',
        "      launch: true",
        '      terminate: "driver_launched"',
      ].join("\n"),
    );
    expect(text.split("\n").filter((line) => line.includes("launch:"))).toHaveLength(2);
    const withoutLaunch = cuaDriverCapabilityManifest({
      applications,
      tools: ["click", "kill_app"],
    });
    expect(withoutLaunch).not.toContain("launch:");
    expect(withoutLaunch).toContain('      terminate: "driver_launched"');
    expect(
      cuaDriverCapabilityManifest({ applications, tools: ["launch_app"] })
        .split("\n")
        .filter((line) => /^ {6}(launch|terminate):/u.test(line)),
    ).toEqual(["      launch: true", "      launch: true"]);
  });

  it("reads launch grants only from an app entry's own launch: true", () => {
    const granted = cuaDriverCapabilityManifest({ applications });
    expect(cuaDriverManifestLaunchGrants(granted)).toEqual([
      "com.apple.calculator",
      "/usr/bin/gedit",
      "gedit",
    ]);
    expect(cuaDriverManifestAllowsTool(granted, "launch_app")).toBe(true);
    const clickOnly = cuaDriverCapabilityManifest({ applications, tools: ["click"] });
    expect(cuaDriverManifestLaunchGrants(clickOnly)).toEqual([]);
    expect(cuaDriverManifestAllowsTool(clickOnly, "launch_app")).toBe(false);
    const mixed = [
      "  apps:",
      '    - bundle_id: "com.apple.Preview"',
      "      launch: false",
      '    - bundle_id: "com.apple.TextEdit"',
      "      launch: true",
      "allow:",
      "  tools:",
      '    - "launch_app"',
      "",
    ].join("\n");
    expect(cuaDriverManifestLaunchGrants(mixed)).toEqual(["com.apple.TextEdit"]);
  });

  it.each([
    [
      "a value other than true or false",
      ['    - bundle_id: "com.apple.calculator"', "      launch: yes"],
    ],
    [
      "a repeated grant in one entry",
      ['    - bundle_id: "com.apple.calculator"', "      launch: true", "      launch: true"],
    ],
    [
      "a grant outside any app entry",
      ["      launch: true", '    - bundle_id: "com.apple.calculator"'],
    ],
    [
      "an app named twice with different grants",
      [
        '    - bundle_id: "com.apple.calculator"',
        "      launch: true",
        '    - bundle_id: "COM.APPLE.CALCULATOR"',
      ],
    ],
  ])("refuses launch data it cannot read as one grant per entry: %s", (_name, lines) => {
    expect(() =>
      cuaDriverManifestLaunchGrants(["  apps:", ...lines, "allow:", ""].join("\n")),
    ).toThrow(invalid);
  });
});
