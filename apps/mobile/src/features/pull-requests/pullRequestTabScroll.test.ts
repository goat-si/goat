import { expect, it, vi } from "vite-plus/test";
import { restorePullRequestTabScroll } from "./pullRequestTabScroll";

it("restores a short Android tab without subtracting system bars or clamping its offset", () => {
  const scrollTo = vi.fn();
  const list = { getNativeScrollRef: () => ({ scrollTo }) };
  const offset = restorePullRequestTabScroll(list, {
    current: 90,
    saved: undefined,
    bodyY: 120,
    topInset: 24,
    platform: "android",
  });
  expect(offset).toBe(90);
  expect(scrollTo).toHaveBeenCalledWith({ y: 90, animated: false });
});

it("restores the iOS offset below its automatically inset header", () => {
  const scrollTo = vi.fn();
  const list = { getNativeScrollRef: () => ({ scrollTo }) };
  const offset = restorePullRequestTabScroll(list, {
    current: 200,
    saved: 160,
    bodyY: 120,
    topInset: 24,
    platform: "ios",
  });
  expect(offset).toBe(160);
  expect(scrollTo).toHaveBeenCalledWith({ y: 160, animated: false });
});
