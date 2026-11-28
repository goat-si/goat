import { it, expect } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

it("an unmatched background wait says Workflow IDs already keep the thread working", () => {
  const error = new ThreadManagementService.ThreadManagementBackgroundWaitError({
    threadId: ThreadId.make("thread:thread-management:background-wait"),
    reason: "unmatched",
  });
  expect(error.message).toContain("Workflow");
});
