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
  it("accepts and ignores a thread driver's launch fingerprint in either option order", () => {
    const fingerprint = "a".repeat(64);
    for (const args of [
      ["--thread", "thread:one", "--driver-fingerprint", fingerprint],
      ["--driver-fingerprint", fingerprint, "--thread", "thread:one"],
    ])
      assert.deepEqual(parseLeaseProxyArguments(args), { mode: "thread", threadId: "thread:one" });
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
    ["--driver-fingerprint", "a"],
    ["--thread", "t", "--driver-fingerprint"],
    ["--thread", "t", "--driver-fingerprint", ""],
    ["--thread", "t", "--driver-fingerprint", "a", "--driver-fingerprint", "b"],
    ["--thread", "t", "--driver-fingerprint", "a", "--unknown", "x"],
    ["--thread", "t", "--driver-fingerprint", "a", "--control", "c"],
    ["--thread", "t", "--driver-fingerprint", "a", "--expires", "2030-01-01T00:00:00Z"],
    ["--control", "c", "--expires", "2030-01-01T00:00:00Z", "--driver-fingerprint", "a"],
  ])("rejects mixed, missing, duplicate or unknown arguments: %j", (...args) => {
    assert.isUndefined(parseLeaseProxyArguments(args));
  });
});
