import { describe, expect, it, vi } from "vite-plus/test";

import { createNewerHostUpdateCheck } from "./newerHostUpdateCheck.logic";

describe("createNewerHostUpdateCheck", () => {
  it("starts one update check for each newer host version and none for older or equal hosts", () => {
    const checkForUpdate = vi.fn();
    const checkWhenHostIsNewer = createNewerHostUpdateCheck(
      "0.1.2-nightly.20261022.236",
      checkForUpdate,
    );

    expect(checkWhenHostIsNewer("0.1.2-nightly.20261022.236")).toBe(false);
    expect(checkWhenHostIsNewer("0.1.1")).toBe(false);
    expect(checkWhenHostIsNewer(null)).toBe(false);
    expect(checkForUpdate).not.toHaveBeenCalled();

    expect(checkWhenHostIsNewer("0.1.2-nightly.20261023.246")).toBe(true);
    expect(checkWhenHostIsNewer("0.1.2-nightly.20261023.246")).toBe(false);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    expect(checkWhenHostIsNewer("0.1.2-nightly.20261023.247")).toBe(true);
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });
});
