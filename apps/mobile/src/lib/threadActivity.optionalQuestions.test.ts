import { describe, expect, it } from "vite-plus/test";

import { buildPendingUserInputAnswers } from "./threadActivity";

const question = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime should be used?",
  options: [
    { label: "Go", description: "One binary" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
};

describe("pending user input answers with optional questions", () => {
  it("submits a picked option without the optional questions left blank", () => {
    const optional = { ...question, id: "notes", options: [], required: false };
    const picked = { runtime: { selectedOptionValues: ["Go"] } };
    expect(buildPendingUserInputAnswers([question, optional], picked)).toEqual({ runtime: "Go" });
    expect(buildPendingUserInputAnswers([question, optional], {})).toBeNull();
  });
});
