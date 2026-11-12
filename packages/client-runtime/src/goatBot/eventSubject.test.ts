import { describe, expect, it } from "vite-plus/test";

import { goatBotEventSubjectSpan } from "./eventSubject.ts";

const routine = (name: string) => ({ kind: "routine" as const, id: "r1", name });

describe("goatBotEventSubjectSpan", () => {
  it("finds the name after the line's first word, even when the name repeats that word", () => {
    expect(
      goatBotEventSubjectSpan({ text: "Routine Routine paused", subject: routine("Routine") }),
    ).toEqual({ before: "Routine ", name: "Routine", after: " paused" });
  });

  it("a line that does not name its subject after the first word has no span", () => {
    expect(
      goatBotEventSubjectSpan({ text: "Standup paused", subject: routine("Standup") }),
    ).toBeUndefined();
    expect(goatBotEventSubjectSpan({ text: "Routine Standup paused" })).toBeUndefined();
  });
});
