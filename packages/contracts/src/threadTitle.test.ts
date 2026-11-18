import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { OrchestrationV2Command } from "./orchestrationV2.ts";
import { OrchestrationV2LastTitleRegenerationJson } from "./threadTitle.ts";

const decodeCommand = Schema.decodeUnknownExit(OrchestrationV2Command);
const decodeStored = Schema.decodeUnknownExit(OrchestrationV2LastTitleRegenerationJson);

const legacyCompletion = {
  type: "thread.title.regeneration.complete",
  commandId: "command-1:title-complete",
  threadId: "thread-1",
  requestId: "command-1",
  title: "Generated title",
};

describe("title regeneration outcome messages", () => {
  it("preserves legacy public completions and discards an outcome supplied with them", () => {
    const legacy = decodeCommand(legacyCompletion);
    expect(legacy).toMatchObject({ _tag: "Success", value: legacyCompletion });
    expect(
      decodeCommand({
        ...legacyCompletion,
        outcome: { status: "failed", message: "Client-supplied text" },
      }),
    ).toEqual(legacy);
  });

  it("keeps the server's outcome-bearing completion off the public dispatch route", () => {
    expect(
      decodeCommand({
        ...legacyCompletion,
        type: "thread.title.regeneration.complete.internal",
        outcome: { status: "failed", message: "Title generation failed." },
      })._tag,
    ).toBe("Failure");
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
