import { expect, it } from "@effect/vitest";
import { AcpProcessExitedError } from "effect-acp/errors";
import { acpRegistryProbeFailure } from "./probe.ts";

it("reports a missing mise-shim ACP agent as unavailable without exposing stderr", () => {
  const error = new AcpProcessExitedError({
    code: 1,
    stderr: "mise ERROR No version is set for shim: agent",
  });
  const failure = acpRegistryProbeFailure(error);
  expect(failure.reason).toBe("runner_unavailable");
  expect(failure.message).not.toContain("mise ERROR");
});
