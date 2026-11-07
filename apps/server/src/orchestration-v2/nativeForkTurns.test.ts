import { expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection } from "@goat/contracts";
import { nativeForkTurns } from "./providerTurnStartHelpers.ts";

it("excludes every attempt of rolled-back runs from native fork bounds", () => {
  const projection = {
    runs: [
      { id: "kept", status: "completed" },
      { id: "undone", status: "rolled_back" },
    ],
    attempts: [
      { id: "kept-attempt", runId: "kept" },
      { id: "old-attempt", runId: "undone" },
      { id: "new-attempt", runId: "undone" },
    ],
    providerTurns: [
      { id: "kept-turn", runAttemptId: "kept-attempt" },
      { id: "old-turn", runAttemptId: "old-attempt" },
      { id: "new-turn", runAttemptId: "new-attempt" },
      { id: "unattributed", runAttemptId: null },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  expect(nativeForkTurns(projection).map((turn) => turn.id)).toEqual(["kept-turn", "unattributed"]);
});
