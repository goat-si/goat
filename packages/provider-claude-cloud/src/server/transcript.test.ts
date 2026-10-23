import { describe, expect, it } from "@effect/vitest";
import { cloudAssistant, cloudPrompt, cloudToolResult, teleportTranscript } from "./testing.ts";
import { readSessionReply, readTeleportResult } from "./transcript.ts";

const RUN_START = Date.parse("2026-10-23T10:00:00.000Z");
const first = [
  cloudPrompt("List the top-level folders.", "2026-10-23T09:00:01.000Z"),
  cloudAssistant({ type: "text", text: "Checking." }, "tool_use"),
  cloudAssistant({ type: "tool_use", id: "tool-1" }, "tool_use"),
  cloudToolResult("tool-1"),
  cloudAssistant({ type: "text", text: "apps, packages, docs" }, "end_turn"),
];
const followUp = cloudPrompt("reply with exactly the word done", "2026-10-23T10:00:02.000Z");

describe("readSessionReply", () => {
  it("imports only the final cloud reply to the run's prompt and ignores the teleport's own turn", () => {
    const transcript = teleportTranscript([
      ...first,
      followUp,
      cloudAssistant({ type: "text", text: "done" }, "end_turn"),
    ]);
    expect(
      readSessionReply(transcript, {
        prompt: "reply with exactly the word done",
        since: RUN_START,
      }),
    ).toEqual({ state: "replied", text: "done" });
    // The first turn's reply is its final text, not the narration before its tool call.
    expect(
      readSessionReply(transcript, { prompt: "List the top-level folders.", since: 0 }),
    ).toEqual({ state: "replied", text: "apps, packages, docs" });
  });

  it("reports a session still working for a tool call, a tool result or a stop_sequence snapshot", () => {
    for (const tail of [
      [cloudAssistant({ type: "tool_use", id: "tool-2" }, "tool_use")],
      [cloudAssistant({ type: "tool_use", id: "tool-2" }, "tool_use"), cloudToolResult("tool-2")],
      [cloudAssistant({ type: "text", text: "| partial" }, "stop_sequence")],
    ])
      expect(
        readSessionReply(teleportTranscript([...first, followUp, ...tail]), { since: RUN_START }),
      ).toEqual({ state: "running" });
  });

  it("waits while the run's prompt has not reached the session, even though an older turn ended", () => {
    expect(
      readSessionReply(teleportTranscript(first), {
        prompt: "reply with exactly the word done",
        since: RUN_START,
      }),
    ).toEqual({ state: "waiting" });
  });

  it("fails with the session's own API error", () => {
    const error = JSON.stringify({
      type: "assistant",
      remoteSourced: true,
      isApiErrorMessage: true,
      message: { content: [{ type: "text", text: "API Error: overloaded" }], stop_reason: null },
    });
    expect(readSessionReply(teleportTranscript([followUp, error]), { since: RUN_START })).toEqual({
      state: "failed",
      error: "API Error: overloaded",
    });
  });
});

it("reads the local fork's ID and cost from the teleport's JSON result", () => {
  expect(
    readTeleportResult(
      '{"type":"result","is_error":false,"session_id":"b29613b5-0000-4000-8000-000000000001","total_cost_usd":0.0064}',
    ),
  ).toEqual({ localSessionId: "b29613b5-0000-4000-8000-000000000001", costUsd: 0.0064 });
  // A session ID becomes a file name, so anything but a UUID is refused.
  expect(readTeleportResult('{"session_id":"../../etc"}')).toBeUndefined();
});
