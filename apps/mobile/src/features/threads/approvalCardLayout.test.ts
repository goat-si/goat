import { describe, expect, it } from "vite-plus/test";

import { approvalActionsFitPinned } from "./approvalCardLayout";

describe("approvalActionsFitPinned", () => {
  it("pins the actions while the title, actions and a readable slice of the request fit", () => {
    expect(approvalActionsFitPinned({ headerHeight: 60, actionsHeight: 52, cardHeight: 420 })).toBe(
      true,
    );
  });

  it("scrolls the whole card when the cap leaves no room for the request beside pinned actions", () => {
    // Large text: three wrapped option rows and a two-line title under a 160pt cap.
    expect(
      approvalActionsFitPinned({ headerHeight: 70, actionsHeight: 150, cardHeight: 160 }),
    ).toBe(false);
  });

  it("stays pinned until both parts have been measured", () => {
    expect(approvalActionsFitPinned({ headerHeight: 0, actionsHeight: 0, cardHeight: 0 })).toBe(
      true,
    );
  });
});
