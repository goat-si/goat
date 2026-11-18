import { describe, expect, it } from "vite-plus/test";
import {
  togglePendingUserInputOptionSelection,
  setPendingUserInputCustomAnswer,
  isPendingUserInputOptionSelected,
  buildPendingUserInputAnswers,
} from "./threadActivity";

const singleSelectQuestion = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime should be used?",
  options: [
    { label: "Go", description: "One binary" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

describe("pending user input answers", () => {
  it("preserves exact editor text, including a deliberately cleared answer", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    expect(
      buildPendingUserInputAnswers([question], {
        runtime: { customAnswer: question.initialAnswer },
      }),
    ).toEqual({ runtime: question.initialAnswer });
    expect(
      buildPendingUserInputAnswers([question], {
        runtime: { customAnswer: "  Edited message\n\n" },
      }),
    ).toEqual({ runtime: "  Edited message\n\n" });
    expect(buildPendingUserInputAnswers([question], { runtime: { customAnswer: "" } })).toEqual({
      runtime: "",
    });
    expect(buildPendingUserInputAnswers([question], { runtime: { customAnswer: " \n" } })).toEqual({
      runtime: " \n",
    });
    expect(setPendingUserInputCustomAnswer(question, { selectedOptionValues: ["Go"] }, "")).toEqual(
      { customAnswer: "" },
    );
  });
});

describe("provider question values", () => {
  const question = {
    ...singleSelectQuestion,
    allowCustomAnswer: false,
    options: [
      { label: "Same label", value: "  exact first  ", description: "First" },
      { label: "Same label", value: "second", description: "Second" },
    ],
  } as const;

  it("submits raw option values and distinguishes duplicate labels", () => {
    const first = togglePendingUserInputOptionSelection(question, undefined, "  exact first  ");
    expect(isPendingUserInputOptionSelected(question, first, "  exact first  ")).toBe(true);
    expect(isPendingUserInputOptionSelected(question, first, "second")).toBe(false);
    expect(buildPendingUserInputAnswers([question], { runtime: first })).toEqual({
      runtime: "  exact first  ",
    });
    expect(togglePendingUserInputOptionSelection(question, first, "Same label")).toBe(first);
  });

  it("rejects arbitrary text when the provider only accepts offered options", () => {
    expect(setPendingUserInputCustomAnswer(question, undefined, "Other")).toEqual({});
    expect(
      buildPendingUserInputAnswers([question], { runtime: { customAnswer: "Other" } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([question], { runtime: { selectedOptionValues: ["unknown"] } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([question], {
        runtime: { selectedOptionValues: ["second"], customAnswer: "stale draft" },
      }),
    ).toEqual({ runtime: "second" });
  });
});

it("accepts ready attachment-only answers while preserving selected options", () => {
  const question = {
    id: "q",
    header: "Spec",
    question: "Provide a specification",
    options: [{ label: "Yes", description: "Approve" }],
    multiSelect: false,
  };
  expect(buildPendingUserInputAnswers([question], { q: { attachmentCount: 1 } })).toEqual({
    q: "",
  });
  expect(
    buildPendingUserInputAnswers([question], {
      q: { attachmentCount: 1, selectedOptionValues: ["Yes"] },
    }),
  ).toEqual({ q: "Yes" });
  expect(
    buildPendingUserInputAnswers([question], {
      q: { attachmentCount: 1, attachmentsBlocked: true },
    }),
  ).toBeNull();
  expect(
    buildPendingUserInputAnswers([{ ...question, allowCustomAnswer: false }], {
      q: { attachmentCount: 1 },
    }),
  ).toBeNull();
});
