import { describe, expect, it } from "vite-plus/test";
import { botTaskLookupDecision } from "./botTaskLookupDecision";

const base = {
  readable: true,
  established: true,
  refreshing: false,
  holdsTask: false,
  held: false,
  stale: false,
  inFlight: false,
};

describe("botTaskLookupDecision", () => {
  it.each([
    ["no list yet: dev content, no read", { established: false }, "dev", false, false],
    ["no list yet while it loads", { established: false, refreshing: true }, "dev", false, false],
    ["listed: the row, no read", { holdsTask: true }, "row", false, false],
    ["listed after an action", { holdsTask: true, held: true, stale: true }, "row", false, false],
    ["absent and unread: read it", {}, "waiting", true, true],
    ["absent during a refresh: wait", { refreshing: true }, "waiting", false, true],
    ["a read is running", { inFlight: true }, "waiting", false, false],
    ["answer held", { held: true }, "held", false, true],
    ["answer held, action since", { held: true, stale: true }, "held", true, true],
    ["held, stale, refreshing", { held: true, stale: true, refreshing: true }, "held", false, true],
    [
      "held, stale, read running",
      { held: true, stale: true, inFlight: true },
      "held",
      false,
      false,
    ],
    ["no capability or permission", { readable: false }, "waiting", false, false],
  ] as const)("%s", (_name, input, view, startRead, canRetry) => {
    expect(botTaskLookupDecision({ ...base, ...input })).toEqual({ view, startRead, canRetry });
  });
});
