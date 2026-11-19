import { expect, it } from "vite-plus/test";
import { initialFeedViewportWidth } from "./thread-feed-initial-width";

it("seeds a remounted split feed with its owning pane width", () => {
  expect(initialFeedViewportWidth(true, 430, 1024)).toBe(430);
  expect(initialFeedViewportWidth(true, null, 1024)).toBe(0);
  expect(initialFeedViewportWidth(false, null, 393)).toBe(393);
});
