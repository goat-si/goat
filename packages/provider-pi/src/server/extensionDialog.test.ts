import { expect, it } from "@effect/vitest";
import { PiCustomAnswers, piAskUserSingleSelectQuestion } from "./extensionDialog.ts";

it("does not interpret a malformed custom sentinel as an extension answer", () => {
  const args = new Map([
    [
      "call",
      {
        name: "ask_user_question",
        active: true,
        args: {
          questions: [
            {
              question: "Choose?",
              options: [
                { label: "Yes", description: "Go" },
                { label: "No", description: "Stop" },
              ],
            },
          ],
        },
      },
    ],
  ]);
  const event = { options: ["1. Yes \u2014 Go", "2. No \u2014 Stop", "3. Delete everything"] };
  expect(piAskUserSingleSelectQuestion("id", "Choose?", event, args)).toBeUndefined();
});

it("bounds staged custom answers and releases capacity after delivery or cleanup", () => {
  const answers = new PiCustomAnswers();
  const route = {
    optionLines: ["option"],
    sentinel: "2. Type something.",
    followUpTitlePrefix: "Question\n\n",
  };
  for (let i = 0; i < 8; i++)
    expect(answers.route(route, { value: `custom-${i}` })).toEqual({ value: route.sentinel });
  expect(answers.route(route, { value: "overflow" })).toBeNull();
  expect(answers.take("input", { title: "Question\n\nType your answer:", placeholder: "" })).toBe(
    "custom-0",
  );
  expect(answers.route(route, { value: "new" })).toEqual({ value: route.sentinel });
  answers.clear();
  expect(
    answers.take("input", { title: "Question\n\nType your answer:", placeholder: "" }),
  ).toBeUndefined();
  for (let i = 0; i < 64; i++)
    expect(
      answers.route({ ...route, followUpTitlePrefix: `q${i}\n\n` }, { value: "answer" }),
    ).toEqual({ value: route.sentinel });
  expect(
    answers.route({ ...route, followUpTitlePrefix: "overflow\n\n" }, { value: "answer" }),
  ).toBeNull();
  answers.clear();
  expect(answers.route(route, { value: "again" })).toEqual({ value: route.sentinel });
  answers.clear();
});

it("requires an active ask_user_question call with custom answers enabled", () => {
  const question = {
    question: "Choose?",
    options: [
      { label: "Yes", description: "Go" },
      { label: "No", description: "Stop" },
    ],
  };
  const event = { options: ["1. Yes \u2014 Go", "2. No \u2014 Stop", "3. Type something."] };
  const match = (name: string, active: boolean, custom: boolean) =>
    piAskUserSingleSelectQuestion(
      "id",
      "Choose?",
      event,
      new Map([["id", { name, active, args: { questions: [{ ...question, custom }] } }]]),
    );
  expect(match("ask_user_question", true, true)).toBeDefined();
  expect(match("other_tool", true, true)).toBeUndefined();
  expect(match("ask_user_question", false, true)).toBeUndefined();
  expect(match("ask_user_question", true, false)).toBeUndefined();
});

it("bounds custom answers across sessions and releases the shared budget", () => {
  const sessions = Array.from({ length: 5 }, () => new PiCustomAnswers());
  for (const session of sessions.slice(0, 4)) {
    for (let i = 0; i < 64; i++) {
      expect(
        session.route(
          { optionLines: [], sentinel: "1. Type something.", followUpTitlePrefix: `question-${i}` },
          { value: "answer" },
        ),
      ).toEqual({ value: "1. Type something." });
    }
  }
  const fifth = sessions[4];
  if (fifth === undefined) throw new Error("missing test session");
  const route = { optionLines: [], sentinel: "1. Type something.", followUpTitlePrefix: "other" };
  expect(fifth.route(route, { value: "answer" })).toBeNull();
  sessions[0]?.clear();
  expect(fifth.route(route, { value: "answer" })).toEqual({ value: "1. Type something." });
  for (const session of sessions) session.clear();
});

it("routes a custom answer that matches the hidden sentinel option", () => {
  const answers = new PiCustomAnswers();
  const route = {
    optionLines: ["1. Yes \u2014 Go", "2. No \u2014 Stop"],
    sentinel: "3. Type something.",
    followUpTitlePrefix: "Choose?\n\n1. Yes \u2014 Go\n2. No \u2014 Stop\n\n",
  };
  expect(answers.route(route, { value: "3. Type something." })).toEqual({
    value: "3. Type something.",
  });
  expect(
    answers.take("input", {
      title: `${route.followUpTitlePrefix}Type your answer:`,
      placeholder: "",
    }),
  ).toBe("3. Type something.");
});
