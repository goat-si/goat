import { expect, it } from "vite-plus/test";
import { sshRuntimeUpdateOutcome } from "./sshRuntimeUpdateOutcome";

it("terminates provider failures and reports the host detail", () => {
  const base = {
    host: "box",
    runtimeVersion: "1.2.2",
    requestedVersion: "1.2.3",
    detail: "Update on host",
  } as const;
  expect(
    sshRuntimeUpdateOutcome({ ...base, state: "providers_not_ready", runtimeVersion: "1.2.3" }),
  ).toEqual({ status: "updated" });
  for (const state of ["ready", "providers_not_ready"] as const)
    expect(sshRuntimeUpdateOutcome({ ...base, state })).toEqual({
      status: "failed",
      message: "Update on host",
    });
  expect(sshRuntimeUpdateOutcome({ ...base, state: "update_blocked" })).toMatchObject({
    status: "failed",
  });
  expect(sshRuntimeUpdateOutcome({ ...base, state: "update_waiting" })).toBeNull();
});
