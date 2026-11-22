import { describe, expect, it } from "vitest";
import type { OrchestrationV2ThreadProjection, OrchestrationV2Run } from "@goat/contracts";
import { providerTurnForRun } from "./ProviderContextBoundaries.ts";

describe("providerTurnForRun", () => {
  it("finds a legacy turn with linear attempt lookups", () => {
    let reads = 0;
    const attempts = Array.from({ length: 300 }, (_, i) => ({
      get id() {
        reads++;
        return `attempt-${i}`;
      },
      providerTurnId: i === 299 ? "legacy" : null,
    }));
    const turns = Array.from({ length: 300 }, (_, i) => ({
      id: i === 299 ? "legacy" : `turn-${i}`,
      runAttemptId: null,
      ordinal: i,
    }));
    const projection = { attempts, providerTurns: turns } as unknown as Pick<
      OrchestrationV2ThreadProjection,
      "attempts" | "providerTurns"
    >;
    const run = { activeAttemptId: "attempt-299" } as OrchestrationV2Run;
    expect(providerTurnForRun(projection, run)).toBe(turns[299]);
    expect(reads).toBeLessThanOrEqual(300);
  });
});
