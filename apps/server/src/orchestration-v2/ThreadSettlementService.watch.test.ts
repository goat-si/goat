import { describe, expect, it } from "@effect/vitest";

import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import { NOW_MS, shell } from "./ThreadSettlementService.testFixtures.ts";

describe("isAutoSettlementCandidate with a watched pull request", () => {
  it("keeps a thread whose watch holds nothing because its checks finished", () => {
    // A pull request watch whose checks finished holds nothing, yet still keeps the thread.
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({
          pendingBackgroundTasks: [
            { taskId: "pull-request-watch:github.com/acme/app#1", kind: "monitor" },
          ],
        }),
        NOW_MS,
      ),
    ).toBe(false);
  });
});
