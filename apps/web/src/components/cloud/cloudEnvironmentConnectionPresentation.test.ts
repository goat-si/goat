import type { EnvironmentConnectionPresentation } from "@goat/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import { presentSavedCloudEnvironmentConnection } from "./cloudEnvironmentConnectionPresentation";

function connection(
  phase: EnvironmentConnectionPresentation["phase"],
  error: string | null = null,
): EnvironmentConnectionPresentation {
  return { phase, error, traceId: null };
}

describe("saved cloud environment connection presentation", () => {
  it("keeps a host that is away idle instead of connecting", () => {
    expect(
      presentSavedCloudEnvironmentConnection({
        ...connection("reconnecting", "Cannot reach mbp over SSH (Operation timed out)."),
        unreachable: true,
      }),
    ).toEqual({
      buttonLabel: "Unreachable",
      statusText:
        "Host unreachable. Reconnecting... Reason: Cannot reach mbp over SSH (Operation timed out).",
      tone: "idle",
    });
  });
});
