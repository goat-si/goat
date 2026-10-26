import { describe, expect, it } from "vite-plus/test";

import { beforeStartTerminationCause } from "./runTerminationCause.ts";

describe("beforeStartTerminationCause", () => {
  it.each([
    ["validation_error", "validation_error"],
    ["usage_limit", "quota"],
    ["provider_error", "provider_error"],
    ["permission_error", "provider_error"],
    ["unknown", "preparation_failed"],
  ] as const)("maps an error item's %s failure to %s", (failureClass, kind) => {
    expect(
      beforeStartTerminationCause({ type: "error", failure: { class: failureClass } }),
    ).toEqual({
      kind,
    });
  });

  it("treats a failed setup command as preparation", () => {
    expect(beforeStartTerminationCause({ type: "command_execution" })).toEqual({
      kind: "preparation_failed",
    });
  });
});
