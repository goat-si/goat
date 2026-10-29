import { expect, it } from "vite-plus/test";

import type { Pose } from "./poses.ts";
import { poolBlocked } from "./report.ts";

const pose: Pose = {
  id: "android-phone-light",
  platform: "android",
  device: "Pixel 9",
  form: "phone",
  appearance: "light",
};

it.each([
  "agent-device snapshot: Failed to read daemon response",
  "agent-device open: Daemon connection closed",
])("a pose stopped by the pool (%s) is reported apart from app failures", (error) => {
  expect(poolBlocked({ pose, steps: [], error })).toBe(true);
});

it("a pose stopped by the app is an app failure", () => {
  expect(poolBlocked({ pose, steps: [], error: "expected the thread list to render" })).toBe(false);
});
