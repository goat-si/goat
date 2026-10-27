import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { TrayMenuPayload } from "./trayMenuPayload.ts";

const decode = Schema.decodeUnknownExit(TrayMenuPayload);
const menu = { attention: [], running: [], pinned: [] };
const prefix = "data:image/png;base64,";

const target = (icon: string | null, threadCount = 1) => ({
  appId: "com.apple.calculator",
  name: "Calculator",
  icon,
  threadCount,
});

const targets = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    appId: `app.${index}`,
    name: `App ${index}`,
    icon: null,
    threadCount: 1,
  }));

describe("TrayMenuPayload", () => {
  it("accepts a menu without computer use, an empty target list, 13 targets, and a 65536-character icon", () => {
    const icon = prefix + "A".repeat(65_536 - prefix.length);
    expect(icon).toHaveLength(65_536);
    expect(decode(menu)._tag).toBe("Success");
    expect(
      decode({ ...menu, computerUse: { threadCount: 1, appCount: 0, targets: [] } })._tag,
    ).toBe("Success");
    expect(
      decode({ ...menu, computerUse: { threadCount: 13, appCount: 13, targets: targets(13) } })
        ._tag,
    ).toBe("Success");
    expect(
      decode({
        ...menu,
        computerUse: { threadCount: 1, appCount: 1, targets: [target(icon)] },
      })._tag,
    ).toBe("Success");
  });

  it("rejects 14 targets, an overlong icon, a non-PNG icon, and a target count above 1000", () => {
    const icon = prefix + "A".repeat(65_537 - prefix.length);
    expect(icon).toHaveLength(65_537);
    expect(
      decode({ ...menu, computerUse: { threadCount: 1, appCount: 14, targets: targets(14) } })._tag,
    ).toBe("Failure");
    expect(
      decode({
        ...menu,
        computerUse: { threadCount: 1, appCount: 1, targets: [target(icon)] },
      })._tag,
    ).toBe("Failure");
    expect(
      decode({
        ...menu,
        computerUse: {
          threadCount: 1,
          appCount: 1,
          targets: [target("data:image/jpeg;base64,aaaa")],
        },
      })._tag,
    ).toBe("Failure");
    expect(
      decode({
        ...menu,
        computerUse: { threadCount: 1, appCount: 1, targets: [target(null, 1001)] },
      })._tag,
    ).toBe("Failure");
  });
});
