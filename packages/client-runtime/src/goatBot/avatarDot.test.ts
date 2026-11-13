import { describe, expect, it } from "vite-plus/test";

import { goatBotWaitingDot } from "./avatarDot.ts";
import { closest, inAvatar, rightEarAndHorn, WEB_AVATAR_SIZES } from "./faceGeometry.testkit.ts";

/** GoatBotAvatar's circle border: the dot is placed from the padding box inside it. */
const BORDER = 1;

describe("goatBotWaitingDot: the waiting dot clears the head at every avatar size", () => {
  const { ear, horn } = rightEarAndHorn();

  it.each(WEB_AVATAR_SIZES)(
    "leaves a gap between the dot and the head at $circle px",
    ({ circle, head }) => {
      const dot = goatBotWaitingDot(circle);
      const centre = {
        x: circle - BORDER - dot.inset - dot.box / 2,
        y: BORDER + dot.inset + dot.box / 2,
      };
      const placed = [...ear, ...horn].map((point) => inAvatar(point, circle, head));
      const gap = closest([centre], placed) - dot.size / 2;
      expect(gap).toBeGreaterThan(0.4);
    },
  );

  it("keeps the dot near 0.28 of the circle, between 6 and 10 px", () => {
    expect(WEB_AVATAR_SIZES.map(({ circle }) => goatBotWaitingDot(circle).size)).toEqual([
      6, 8, 10, 10,
    ]);
  });
});
