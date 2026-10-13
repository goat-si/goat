import { describe, expect, it } from "vite-plus/test";

import { pullRequestHoldReason } from "./pullRequestHold.ts";

const open = { isDraft: false, labels: [], body: "" };

describe("pullRequestHoldReason", () => {
  it("holds a draft", () => {
    expect(pullRequestHoldReason({ ...open, isDraft: true })).toBe("it is still a draft");
  });

  it.each([
    "HOLD",
    "hold",
    "On Hold",
    "do not merge",
    "DO-NOT-MERGE",
    "don't merge",
    "do_not_merge",
  ])("holds the %s label", (name) => {
    expect(pullRequestHoldReason({ ...open, labels: [{ name }] })).toBe(
      `it has the "${name}" label`,
    );
  });

  it.each([
    "HOLD: do not merge until Jun approves screenshots",
    "Summary\n\n**HOLD** until the API ships",
    "> HOLD — waiting on design",
    "- HOLD",
  ])("holds a description line %j", (body) => {
    expect(pullRequestHoldReason({ ...open, body })).toBe("its description has a HOLD line");
  });

  it.each([
    "Raises the threshold. Hold Cmd to select.",
    "The lease HOLDER now retries.",
    "We should hold off on the rename later.",
  ])("does not read %j as a hold", (body) => {
    expect(
      pullRequestHoldReason({ ...open, body, labels: [{ name: "holdout-tests" }] }),
    ).toBeNull();
  });
});
