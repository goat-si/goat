import { assert, describe, it } from "@effect/vitest";
import { parseLeaseProxyArguments } from "./ComputerUseLeaseProxyArguments.ts";

describe("lease proxy arguments", () => {
  it("accepts thread or legacy control mode", () => {
    assert.deepEqual(parseLeaseProxyArguments(["--thread", "thread:one"]), {
      mode: "thread",
      threadId: "thread:one",
    });
    assert.equal(
      parseLeaseProxyArguments(["--control", "control:one", "--expires", "2030-01-01T00:00:00Z"])
        ?.mode,
      "control",
    );
  });
  it.each([
    [],
    ["--thread"],
    ["--thread", ""],
    ["--thread", "t", "--control", "c"],
    ["--thread", "t", "--expires", "2030-01-01T00:00:00Z"],
    ["--control", "c"],
    ["--control", "c", "--expires", "invalid"],
    ["--thread", "t", "--unknown", "x"],
    ["--thread", "a", "--thread", "b"],
    ["--control", "c", "--expires", "2030-01-01T00:00:00Z", "--unknown", "x"],
    ["--thread", "--control"],
    ["--thread", "t", "unexpected"],
  ])("rejects mixed, missing, duplicate or unknown arguments: %j", (...args) => {
    assert.isUndefined(parseLeaseProxyArguments(args));
  });
});
