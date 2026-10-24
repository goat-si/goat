import { describe, expect, it } from "vite-plus/test";

import { defectSummary } from "./dispatchEnvelope.ts";

describe("defectSummary", () => {
  it("names what died without the defect's fields or credentials", () => {
    const defect = new Error("handler died with Bearer abcdefghijklmnopqrstuvwxyz0123", {
      cause: {
        authorization: "Bearer canary-cause-token-0123456789",
        accessToken: "canary-access",
      },
    });
    const summary = defectSummary(defect);
    expect(summary).toContain("Error: handler died with Bearer ***");
    expect(summary).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(summary).not.toContain("canary");
    // A thrown value that is not an Error is named by its type only.
    expect(defectSummary({ token: "canary-object-token" })).toBe("non-Error defect (object)");
  });
});
