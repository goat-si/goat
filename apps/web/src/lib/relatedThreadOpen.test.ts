import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { targetShellOmitsChildren } from "./relatedThreadOpen";

const here = EnvironmentId.make("here");
const studio = EnvironmentId.make("studio");

describe("targetShellOmitsChildren", () => {
  it("reads the thread's own environment, not the timeline's, when they differ", () => {
    const configs = new Map([[studio, { shellThreadFamilies: true }]]);
    expect(
      targetShellOmitsChildren({
        targetEnvironmentId: studio,
        currentEnvironmentId: here,
        currentConfig: { shellThreadFamilies: false },
        configs,
      }),
    ).toBe(true);
    expect(
      targetShellOmitsChildren({
        targetEnvironmentId: here,
        currentEnvironmentId: here,
        currentConfig: { shellThreadFamilies: false },
        configs,
      }),
    ).toBe(false);
    // A machine whose configuration has not loaded yet is treated as listing every thread.
    expect(
      targetShellOmitsChildren({
        targetEnvironmentId: studio,
        currentEnvironmentId: here,
        currentConfig: { shellThreadFamilies: true },
        configs: new Map(),
      }),
    ).toBe(false);
  });
});
