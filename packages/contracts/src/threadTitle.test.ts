import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { OrchestrationV2Command } from "./orchestrationV2.ts";
import { OrchestrationV2LastTitleRegenerationJson } from "./threadTitle.ts";

const decodeCommand = Schema.decodeUnknownExit(OrchestrationV2Command);
const decodeStored = Schema.decodeUnknownExit(OrchestrationV2LastTitleRegenerationJson);

const completion = (message: string) => ({
  type: "thread.title.regeneration.complete",
  commandId: "command-1:title-complete",
  threadId: "thread-1",
  requestId: "command-1",
  outcome: { status: "failed", message },
});

describe("title regeneration outcome messages", () => {
  it("refuses a completion command whose message is longer than 300 characters", () => {
    expect(decodeCommand(completion("x".repeat(300)))._tag).toBe("Success");
    expect(decodeCommand(completion("x".repeat(301)))._tag).toBe("Failure");
  });

  it("still decodes a stored outcome of any length", () => {
    const stored = decodeStored({
      status: "failed",
      message: "x".repeat(400),
      requestId: "command-1",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(stored._tag).toBe("Success");
  });
});
