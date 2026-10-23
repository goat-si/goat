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
const anchor = {
  prompt: "reply with exactly the word done",
  since: RUN_START,
  ownership: "unique",
} as const;

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
    expect(readSessionReply(transcript, { since: 0, ownership: "creation" })).toEqual({
      state: "replied",
      text: "apps, packages, docs",
    });
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
    expect(
      readSessionReply(teleportTranscript(first), { since: RUN_START, ownership: "unique" }),
    ).toEqual({ state: "waiting" });
  });

  it("does not take a snapshot for a reply when another prompt queues behind it", () => {
    const queued = [
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
    expect(readSessionReply(teleportTranscript([followUp, error]), anchor)).toEqual({
      state: "failed",
      error: "API Error: overloaded",
    });
  });
});

describe("a prompt the run cannot prove is its own", () => {
  const answered = (stamp: string, text: string) => [
    cloudPrompt("reply with exactly the word done", stamp),
    cloudAssistant({ type: "text", text }, "end_turn"),
  ];
  it.each([
    // Typed on claude.ai while GOAT was still checking readiness, then answered.
    ["sent during readiness", "2026-10-23T10:00:01.000Z"],
    // Sent just before the run started, stamped after it by a cloud clock running ahead.
    ["stamped late by a fast cloud clock", "2026-10-23T10:00:03.000Z"],
    // An identical earlier prompt, by GOAT or claude.ai, within the clock-skew allowance.
    ["sent just before the run", "2026-10-23T09:59:50.000Z"],
  ])("an identical prompt %s makes the run unattributable once its own arrives", (_, stamp) => {
    const transcript = teleportTranscript([
      ...answered(stamp, "Someone else's answer."),
      cloudPrompt("reply with exactly the word done", "2026-10-23T10:00:04.000Z"),
    ]);
    expect(readSessionReply(transcript, anchor).state).toBe("unattributable");
  });

  it("a matching prompt without a time is never guessed", () => {
    const unstamped = teleportTranscript(answered("2026-10-23T10:00:02.000Z", "done")).replaceAll(
      /"timestamp":"[^"]*",/g,
      "",
    );
    expect(readSessionReply(unstamped, anchor).state).toBe("unattributable");
  });

  it("the creating turn keeps the session's first prompt whatever follows", () => {
    const transcript = teleportTranscript([
      ...answered("2026-10-23T10:00:30.000Z", "GOAT's answer."),
      ...answered("2026-10-23T10:00:40.000Z", "Someone else's answer."),
    ]);
    expect(readSessionReply(transcript, { since: RUN_START, ownership: "creation" })).toEqual({
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
