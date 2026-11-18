import { expect, it } from "vite-plus/test";
import { composerPlaceholder } from "./composerPlaceholder";

it("does not suggest a selected option when the question has none", () => {
  const base = {
    approval: null,
    planFollowUp: false,
    projectSelectionRequired: false,
    showProviderUnavailable: false,
  };
  expect(
    composerPlaceholder({
      ...base,
      question: { options: [] },
    }),
  ).toBe("Type your answer");
  expect(
    composerPlaceholder({
      ...base,
      question: { options: ["one"] },
    }),
  ).toContain("selected option");
  expect(
    composerPlaceholder({
      ...base,
      question: { allowCustomAnswer: false, options: ["one"] },
    }),
  ).toBe("Choose an option above");
});
