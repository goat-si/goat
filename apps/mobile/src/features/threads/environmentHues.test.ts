import { expect, it } from "vite-plus/test";
import { assignMobileEnvironmentHues } from "./environmentHues";

it("leaves the hub neutral and assigns the web hues to remote devices", () => {
  const hues = assignMobileEnvironmentHues(
    ["cloud-sandbox", "headless-1", "headless-2"],
    "headless-2",
  );
  expect(hues.has("headless-2")).toBe(false);
  expect(hues.get("cloud-sandbox")).toBe("accent-orange-500");
  expect(hues.get("headless-1")).toBe("accent-emerald-500");
});
