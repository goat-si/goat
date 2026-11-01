import { RunId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  channelEvidenceSentence,
  channelPersonEvidenceLabels,
  splitChannelResultText,
} from "./channelEvidence.ts";

const runId = RunId.make("run");

describe("splitChannelResultText", () => {
  it("removes report trailers and keeps what the agent did not run", () => {
    expect(
      splitChannelResultText(
        "OpenCodex has 17.8k stars.\nNOT RUN: separate tests.\nReported tests: not reported\n- GOAT check: not run",
      ),
    ).toEqual({ text: "OpenCodex has 17.8k stars.", notRun: "separate tests." });
  });

  it("leaves prose that only mentions the words alone", () => {
    expect(splitChannelResultText("Tests did not run: NOT RUN: is the protocol.")).toEqual({
      text: "Tests did not run: NOT RUN: is the protocol.",
      notRun: null,
    });
  });
});

describe("evidence for people", () => {
  it("says nothing when no tests were reported and no check runs", () => {
    const result = { runId, observedCheckPending: false };
    expect(channelPersonEvidenceLabels(result)).toEqual([]);
    expect(channelEvidenceSentence(result)).toBeNull();
    expect(channelPersonEvidenceLabels(undefined)).toEqual([]);
  });

  it("keeps the agent's claim beside GOAT's own check once either exists", () => {
    const result = { runId, tests: { ok: true } };
    expect(channelPersonEvidenceLabels(result)).toEqual([
      "Reported tests: passed",
      "GOAT check: not available",
    ]);
    expect(channelEvidenceSentence(result, "fix the build")).toBe(
      "Verification for fix the build: the agent reported tests passed; GOAT's own check is not available.",
    );
    expect(channelEvidenceSentence({ runId, observedCheckPending: true })).toBe(
      "Verification: the agent reported no tests; GOAT's own check is pending.",
    );
  });
});
