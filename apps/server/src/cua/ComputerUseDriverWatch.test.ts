import { assert, describe, it } from "@effect/vitest";

import { exitReason } from "./ComputerUseDriverExit.ts";
import { makeDriverWatch } from "./ComputerUseDriverWatch.ts";

describe("ComputerUseDriverWatch", () => {
  it("a child that exits before writing a line reports its ending, with the exit's reason", () => {
    const watch = makeDriverWatch();
    assert.deepEqual(watch.exited(77), {
      driverEnded: { reason: "helper_refused", exitCode: 77 },
    });
    // One report per child.
    assert.isUndefined(watch.exited(77));
    assert.isUndefined(watch.answered());
  });

  it("a child that answered reports once that it works, and its later exit says nothing", () => {
    const watch = makeDriverWatch();
    assert.deepEqual(watch.answered(), { driverEnded: false });
    assert.isUndefined(watch.answered());
    assert.isUndefined(watch.exited(134));
  });

  it("a child the proxy stops says nothing about the agent route", () => {
    const watch = makeDriverWatch();
    watch.stopping();
    assert.isUndefined(watch.exited(undefined));
  });

  it("reads the helper's refusal codes, and any other exit as a stop or restart", () => {
    assert.equal(exitReason(77), "helper_refused");
    for (const code of [64, 78, 79]) assert.equal(exitReason(code), "helper_unsupported");
    for (const code of [0, 1, 134, undefined]) assert.equal(exitReason(code), "helper_restarted");
  });
});
