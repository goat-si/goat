import { describe, expect, it } from "@effect/vitest";
import { cloudAssistant, cloudPrompt, cloudToolResult, teleportTranscript } from "./testing.ts";
import { countPrompts, readSessionReply, readTeleportResult } from "./transcript.ts";

const first = [
  cloudPrompt("List the top-level folders.", "2026-10-23T09:00:01.000Z"),
  cloudAssistant({ type: "text", text: "Checking." }, "tool_use"),
  cloudAssistant({ type: "tool_use", id: "tool-1" }, "tool_use"),
  cloudToolResult("tool-1"),
  cloudAssistant({ type: "text", text: "apps, packages, docs" }, "end_turn"),
];
const DONE = "reply with exactly the word done";
const followUp = cloudPrompt(DONE, "2026-10-23T10:00:02.000Z");
// A follow-up sent after a read that saw the session's one earlier prompt.
const anchor = { prompt: DONE, ownership: "unique", after: 1 } as const;

describe("readSessionReply", () => {
  it("imports only the final cloud reply to the run's prompt and ignores the teleport's own turn", () => {
    const transcript = teleportTranscript([
      ...first,
      followUp,
      cloudAssistant({ type: "text", text: "done" }, "end_turn"),
    ]);
    expect(readSessionReply(transcript, anchor)).toEqual({ state: "replied", text: "done" });
    // The session's creating turn owns its first prompt; its reply is the final text, not the
    // narration before its tool call.
    expect(readSessionReply(transcript, { ownership: "creation" })).toEqual({
      state: "replied",
      text: "apps, packages, docs",
    });
    // The teleport's own local prompt and reply are not cloud prompts.
    expect(countPrompts(transcript)).toBe(2);
  });

  it("reports a session still working for a tool call, a tool result or a stop_sequence snapshot", () => {
    for (const tail of [
      [cloudAssistant({ type: "tool_use", id: "tool-2" }, "tool_use")],
      [cloudAssistant({ type: "tool_use", id: "tool-2" }, "tool_use"), cloudToolResult("tool-2")],
      [cloudAssistant({ type: "text", text: "| partial" }, "stop_sequence")],
    ])
      expect(readSessionReply(teleportTranscript([...first, followUp, ...tail]), anchor)).toEqual({
        state: "running",
      });
  });

  it("waits while the run's prompt has not reached the session, even though an older turn ended", () => {
    expect(readSessionReply(teleportTranscript(first), anchor)).toEqual({ state: "waiting" });
    expect(readSessionReply(teleportTranscript(first), { ownership: "unique", after: 1 })).toEqual({
      state: "waiting",
    });
  });

  it("does not take a snapshot for a reply when another prompt queues behind it", () => {
    const queued = [
      ...first,
      followUp,
      cloudAssistant({ type: "text", text: "| partial" }, "stop_sequence"),
      cloudPrompt("also count them", "2026-10-23T10:00:05.000Z"),
    ];
    expect(readSessionReply(teleportTranscript(queued), anchor)).toEqual({ state: "running" });
    expect(
      readSessionReply(
        teleportTranscript([
          ...queued,
          cloudAssistant({ type: "text", text: "done, 3" }, "end_turn"),
        ]),
        anchor,
      ),
    ).toEqual({ state: "replied", text: "done, 3" });
  });

  it("fails with the session's own API error", () => {
    const error = JSON.stringify({
      type: "assistant",
      remoteSourced: true,
      isApiErrorMessage: true,
      message: { content: [{ type: "text", text: "API Error: overloaded" }], stop_reason: null },
    });
    expect(readSessionReply(teleportTranscript([...first, followUp, error]), anchor)).toEqual({
      state: "failed",
      error: "API Error: overloaded",
    });
  });
});

describe("which prompt is the run's", () => {
  const answered = (stamp: string, text: string) => [
    cloudPrompt(DONE, stamp),
    cloudAssistant({ type: "text", text }, "end_turn"),
  ];
  it("a repeated message owns the prompt after the boundary, not the earlier answered one", () => {
    const transcript = teleportTranscript([
      ...answered("2026-10-23T09:59:50.000Z", "Earlier answer."),
      ...answered("2026-10-23T10:00:03.000Z", "New answer."),
    ]);
    expect(readSessionReply(transcript, anchor)).toEqual({ state: "replied", text: "New answer." });
  });

  it("an identical prompt from claude.ai after the boundary makes the run unattributable", () => {
    // Whatever the clocks say: here the cloud stamps the external prompt after GOAT's.
    const transcript = teleportTranscript([
      ...first,
      ...answered("2026-10-23T11:59:15.000Z", "Someone else's answer."),
      cloudPrompt(DONE, "2026-10-23T11:58:01.000Z"),
    ]);
    expect(readSessionReply(transcript, anchor).state).toBe("unattributable");
  });

  it("without a boundary every matching prompt in the session competes", () => {
    const transcript = teleportTranscript([
      ...answered("2026-10-23T08:00:00.000Z", "Hours-old answer."),
      cloudPrompt(DONE, "2026-10-23T10:00:03.000Z"),
    ]);
    expect(readSessionReply(transcript, { prompt: DONE, ownership: "unique" }).state).toBe(
      "unattributable",
    );
  });

  it("the creating turn keeps the session's first prompt whatever follows", () => {
    const transcript = teleportTranscript([
      ...answered("2026-10-23T10:00:30.000Z", "GOAT's answer."),
      ...answered("2026-10-23T10:00:40.000Z", "Someone else's answer."),
    ]);
    expect(readSessionReply(transcript, { ownership: "creation" })).toEqual({
      state: "replied",
      text: "GOAT's answer.",
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
