import { useState, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../goat-bot/MobileBotList", () => ({
  MobileHomeModeSegments: () => {
    const [mode, setMode] = useState("Threads");
    return <button onClick={() => setMode("Bots")}>{mode}</button>;
  },
}));

export function registerEmptyHomeModeTest(
  home: () => ReactNode,
  render: (node: ReactNode) => Promise<void>,
  click: (label: string) => Promise<void>,
  button: (label: string) => HTMLButtonElement,
) {
  it("keeps the mode switch available on an empty iOS home", async () => {
    await render(home());
    await click("Threads");
    expect(button("Bots")).toBeDefined();
  });
}

export const navigationCases = [
  ["home", "ios", "populated"],
  ["home", "android", "populated"],
  ["home", "ios", "empty"],
  ["home", "android", "empty"],
  ["home", "ios", "filtered"],
  ["home", "android", "filtered"],
  ["sidebar", "ios", "populated"],
  ["sidebar", "android", "populated"],
  ["sidebar", "ios", "empty"],
  ["sidebar", "android", "empty"],
  ["sidebar", "ios", "filtered"],
  ["sidebar", "android", "filtered"],
  ["home", "ios", "project"],
  ["home", "android", "project"],
  ["sidebar", "ios", "project"],
  ["sidebar", "android", "project"],
  ["home", "ios", "environment"],
  ["home", "android", "environment"],
  ["sidebar", "ios", "environment"],
  ["sidebar", "android", "environment"],
] as const;
