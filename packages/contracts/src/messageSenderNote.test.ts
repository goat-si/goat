import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ScheduledTaskId, ThreadId } from "./index.ts";
import { withMessageSenderNote } from "./messageSenderNote.ts";

const user = { text: "Review this", createdBy: "user" as const, creationSource: "web" as const };
const agent = { ...user, createdBy: "agent" as const, creationSource: "mcp" as const };

describe("message sender notes", () => {
  it("distinguishes a person, a local agent, a linked agent, and a scheduled task", () => {
    expect(withMessageSenderNote(user, user.text)).toBe(user.text);
    expect(
      withMessageSenderNote({ ...agent, senderThreadId: ThreadId.make('lane"one') }, agent.text),
    ).toContain('lane\\"one');
    expect(
      withMessageSenderNote(
        {
          ...agent,
          context: {
            version: 1,
            records: [],
            remoteSender: {
              environmentId: EnvironmentId.make("remote"),
              environmentLabel: "Remote",
              threadId: ThreadId.make("lane"),
              title: "Lane",
            },
          },
        },
        agent.text,
      ),
    ).toContain('linked environment "remote"');
    expect(
      withMessageSenderNote({ ...user, scheduledTaskId: ScheduledTaskId.make("task") }, user.text),
    ).toContain('scheduled task "task"');
    expect(withMessageSenderNote(agent, agent.text)).toContain("GOAT's tools");
  });
  it.each(["/compact", "$deploy now", "€review now"])(
    "preserves leading provider commands and skill mentions: %s",
    (text) => {
      expect(withMessageSenderNote({ ...agent, text }, text)).toBe(text);
    },
  );
});
