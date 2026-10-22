import type { HubDeviceOperationResult } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hubStepRows } from "./hubDeviceSteps";

const KEY = "ssh-ed25519 SHA256:abc";

describe("hubStepRows", () => {
  it("adds the host-key outcome after a probe and ends on parity", () => {
    const result: HubDeviceOperationResult = {
      deviceAlias: "mac-studio",
      action: "join",
      state: "degraded",
      message: "mac-studio is linked, but P6 still fail.",
      steps: [
        { step: "probe", outcome: "ok", detail: KEY },
        { step: "link_add", outcome: "ok", detail: "lnk_1" },
        { step: "sync", outcome: "failed", detail: "ocx sync exited 1." },
      ],
      parity: {
        verdict: "degraded",
        checkedAt: 0,
        failingCheckIds: ["P6"],
        checks: [{ id: "P6", status: "failed", reason: "settings differ" }],
      },
    };
    expect(
      hubStepRows(result, undefined).map(({ label, outcome, detail }) => [label, outcome, detail]),
    ).toEqual([
      ["Probe and host key", "ok", KEY],
      ["Host key", "ok", "Matches GOAT's pinned key."],
      ["Link add", "ok", "lnk_1"],
      ["Repair 1 · ocx sync", "failed", "ocx sync exited 1."],
      ["Parity", "failed", "degraded (P6)"],
    ]);
    expect(hubStepRows(result, "decision-1")[1]?.detail).toBe("Approved in a decision.");
  });

  it("a join waiting on a decision says why the key was not accepted", () => {
    const rows = hubStepRows(
      {
        deviceAlias: "lidge-ts",
        action: "join",
        state: "needs_human",
        message: "GOAT has no pinned host key for this alias.",
        steps: [{ step: "probe", outcome: "ok", detail: KEY }],
        decisionId: "decision-1",
      },
      undefined,
    );
    expect(rows[1]).toMatchObject({
      label: "Host key",
      outcome: "waiting",
      detail: "GOAT has no pinned host key for this alias.",
    });
  });
});
