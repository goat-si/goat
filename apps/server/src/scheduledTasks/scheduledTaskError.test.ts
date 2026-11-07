import { expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { dispatchFailureDetails } from "./scheduledTaskError.ts";

it("shows the underlying dispatch failure without its stack and keeps defects unresolved", () => {
  const failure = new Error("could not start", { cause: new Error("executable missing") });
  expect(dispatchFailureDetails(Exit.fail(failure))).toEqual({
    dispatchEvidence: "rejected",
    dispatchError: "executable missing",
  });
  expect(dispatchFailureDetails(Exit.failCause(Cause.die(new Error("uncertain"))))).toEqual({
    dispatchEvidence: "unresolved",
    dispatchError: null,
  });
});
