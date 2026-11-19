import { expect, it } from "vite-plus/test";
import { feedHasLanded, feedHeaderHidden } from "./thread-feed-landing";

it("keeps a nonempty feed header hidden until its list is laid out", () => {
  expect(feedHeaderHidden(true, false)).toBe(true);
  expect(feedHeaderHidden(true, true)).toBe(false);
  expect(feedHeaderHidden(false, false)).toBe(false);
});

it("waits for actual end landing while allowing explicit jumps and manual scrolling", () => {
  expect(
    feedHasLanded({ loaded: true, distanceFromEnd: 500, followsEnd: true, jumping: false }),
  ).toBe(false);
  expect(
    feedHasLanded({ loaded: true, distanceFromEnd: 2, followsEnd: true, jumping: false }),
  ).toBe(true);
  expect(
    feedHasLanded({ loaded: true, distanceFromEnd: 500, followsEnd: false, jumping: false }),
  ).toBe(true);
  expect(
    feedHasLanded({ loaded: true, distanceFromEnd: 500, followsEnd: true, jumping: true }),
  ).toBe(true);
  expect(
    feedHasLanded({ loaded: false, distanceFromEnd: 0, followsEnd: true, jumping: false }),
  ).toBe(false);
});
