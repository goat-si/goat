import { expect, it } from "vite-plus/test";
import { feedHeaderHidden } from "./thread-feed-landing";

it("keeps a nonempty feed header hidden until its list is laid out", () => {
  expect(feedHeaderHidden(true, false)).toBe(true);
  expect(feedHeaderHidden(true, true)).toBe(false);
  expect(feedHeaderHidden(false, false)).toBe(false);
});
