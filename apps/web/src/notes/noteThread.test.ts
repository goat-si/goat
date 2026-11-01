import { RunId, type ThreadResult } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { noteThreadPresentation } from "./noteThread";

const result: ThreadResult = {
  runId: RunId.make("run-1"),
  runStatus: "completed",
  outcome: "succeeded",
  reportedAt: null,
  pullRequests: [],
  commits: [],
  branch: null,
};

describe("note linked thread presentation", () => {
  it("shows the known hub thread title and identifies a missing result as pending", () => {
    expect(noteThreadPresentation({ host: null, lastResult: null }, "  Review note  ")).toEqual({
      label: "Review note · This hub",
      status: "No result yet",
    });
  });
  it("uses a short label for unknown local threads without claiming the host is unavailable", () => {
    expect(noteThreadPresentation({ host: null, lastResult: null }, undefined)).toEqual({
      label: "Thread · This hub",
      status: "No result yet",
    });
  });
  it("includes the remote host when no title or result is known", () => {
    expect(noteThreadPresentation({ host: "remote", lastResult: null }, " ")).toEqual({
      label: "Thread · remote",
      status: "No result yet",
    });
  });
  it("uses a known remote title while retaining its host", () => {
    expect(noteThreadPresentation({ host: "remote", lastResult: result }, "Remote work")).toEqual({
      label: "Remote work · remote",
      status: "completed · succeeded",
    });
  });
  it("shows an available result regardless of host and preserves the unreported outcome", () => {
    for (const host of [null, "remote"]) {
      expect(noteThreadPresentation({ host, lastResult: result }, undefined).status).toBe(
        "completed · succeeded",
      );
      expect(
        noteThreadPresentation({ host, lastResult: { ...result, outcome: null } }, undefined)
          .status,
      ).toBe("completed · No result reported");
    }
  });
});
