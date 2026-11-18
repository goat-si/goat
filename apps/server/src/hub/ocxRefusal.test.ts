import { expect, it } from "@effect/vitest";

import { refusalOf } from "./ocxRefusal.ts";

it("reads the code, hint and outcome from ocx's own revoke and recover refusal lines", () => {
  expect(
    refusalOf(
      "Error: Link revoke did not complete (operation a1.revoke.1: failed_clean) (code remote_disconnect_failed, hint child_residual). The lightweight Child keeps records it cannot restore.\n",
    ),
  ).toEqual({ code: "remote_disconnect_failed", hint: "child_residual", outcome: "failed_clean" });
  // An unreachable machine: the code alone.
  expect(
    refusalOf(
      "Error: Link revoke did not complete (operation a1.purge.2: unknown) (code remote_disconnect_failed)",
    ),
  ).toEqual({ code: "remote_disconnect_failed", outcome: "unknown" });
  expect(
    refusalOf(
      "Error: Link lnk_0123456789abcdef is not on this Home; no revoke was journalled (code link_not_found).",
    ),
  ).toEqual({ code: "link_not_found" });
  expect(
    refusalOf(
      "Error: Too many forced revokes of ephemeral Children are waiting for cleanup; (code tombstone_limit)",
    ),
  ).toEqual({ code: "tombstone_limit" });
  expect(
    refusalOf("Error: Link recover refused (502): remote_recover_failed (ssh_failed)"),
  ).toEqual({ code: "remote_recover_failed", hint: "ssh_failed" });
  expect(
    refusalOf(
      "Error: Link recover refused (409): alias_linked: another Home-initiated link still uses this machine's alias",
    ),
  ).toEqual({ code: "alias_linked" });
});

it("reads nothing from a line that is not ocx's own refusal", () => {
  expect(refusalOf("")).toBeUndefined();
  // Words a machine could echo elsewhere decide nothing.
  expect(refusalOf("debug: (code remote_disconnect_failed, hint child_residual)")).toBeUndefined();
  expect(refusalOf("Error: something else (code Bad-Code)")).toBeUndefined();
});
