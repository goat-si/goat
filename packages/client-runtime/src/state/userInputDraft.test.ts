import type { UserInputQuestion } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { seedUserInputDraftAnswers } from "./threadRequests.ts";
import {
  buildPendingUserInputAnswers,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./userInputDraft.ts";

const question: UserInputQuestion = {
  id: "q",
  header: "Choice",
  question: "Choose",
  options: [
    { label: "One", value: "  exact\t", description: "First choice" },
    { label: "Two", value: "two", description: "Second choice" },
  ],
  multiSelect: false,
};

describe("shared user input drafts", () => {
  it("rejects unanswered questions, stale options, and forbidden custom answers", () => {
    const optionsOnly = { ...question, allowCustomAnswer: false };
    expect(buildPendingUserInputAnswers([question], {})).toBeNull();
    expect(
      buildPendingUserInputAnswers([question], { q: { selectedOptionValues: ["stale"] } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([optionsOnly], { q: { customAnswer: "Other" } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([optionsOnly], {
        q: { customAnswer: "Other", selectedOptionValues: ["two"] },
      }),
    ).toEqual({ q: "two" });
    expect(
      buildPendingUserInputAnswers([question, { ...question, id: "second" }], {
        q: { selectedOptionValues: ["two"] },
      }),
    ).toBeNull();
    expect(buildPendingUserInputAnswers([], {})).toEqual({});
  });

  it("submits a picked option without the optional questions left blank", () => {
    const optional = { ...question, id: "notes", options: [], required: false };
    expect(
      buildPendingUserInputAnswers([question, optional], { q: { selectedOptionValues: ["two"] } }),
    ).toEqual({ q: "two" });
    expect(
      buildPendingUserInputAnswers([question, optional], {
        q: { selectedOptionValues: ["two"] },
        notes: { customAnswer: "Later" },
      }),
    ).toEqual({ q: "two", notes: "Later" });
    expect(buildPendingUserInputAnswers([question, optional], {})).toBeNull();
  });

  it("seeds once and preserves clearing, edits, and selections on later snapshots", () => {
    const initial = { ...question, initialAnswer: "  message\n\n" };
    const seeded = seedUserInputDraftAnswers([initial], {});
    expect(buildPendingUserInputAnswers([initial], seeded)).toEqual({ q: "  message\n\n" });
    const cleared = { q: setPendingUserInputCustomAnswer(seeded.q, "", initial) };
    expect(seedUserInputDraftAnswers([initial], cleared)).toBe(cleared);
    expect(buildPendingUserInputAnswers([initial], cleared)).toEqual({ q: "" });
    const edited = { q: setPendingUserInputCustomAnswer(cleared.q, "  edited\n", initial) };
    expect(seedUserInputDraftAnswers([initial], edited)).toBe(edited);
    expect(buildPendingUserInputAnswers([initial], edited)).toEqual({ q: "  edited\n" });
    const selected = { q: togglePendingUserInputOptionSelection(initial, edited.q, "two") };
    expect(seedUserInputDraftAnswers([initial], selected)).toBe(selected);
    expect(buildPendingUserInputAnswers([initial], selected)).toEqual({ q: "two" });
    expect(seedUserInputDraftAnswers([{ ...initial, allowCustomAnswer: false }], {})).toEqual({});
  });

  it("keeps exact provider option values and replaces single selections", () => {
    const selected = togglePendingUserInputOptionSelection(question, undefined, "  exact\t");
    expect(buildPendingUserInputAnswers([question], { q: selected })).toEqual({ q: "  exact\t" });
    const replaced = togglePendingUserInputOptionSelection(question, selected, "two");
    expect(buildPendingUserInputAnswers([question], { q: replaced })).toEqual({ q: "two" });
    expect(
      buildPendingUserInputAnswers([question], {
        q: { selectedOptionValues: ["unknown", "  exact\t", "  exact\t"] },
      }),
    ).toEqual({ q: "  exact\t" });
  });

  it("toggles multiple selections and filters stale values without reordering answers", () => {
    const multi = { ...question, multiSelect: true };
    const one = togglePendingUserInputOptionSelection(multi, undefined, "  exact\t");
    const both = togglePendingUserInputOptionSelection(multi, one, "two");
    expect(buildPendingUserInputAnswers([multi], { q: both })).toEqual({ q: ["  exact\t", "two"] });
    const two = togglePendingUserInputOptionSelection(multi, both, "  exact\t");
    expect(buildPendingUserInputAnswers([multi], { q: two })).toEqual({ q: ["two"] });
    expect(
      buildPendingUserInputAnswers([multi], {
        q: { selectedOptionValues: ["stale", "two", "two"] },
      }),
    ).toEqual({ q: ["two"] });
    const empty = togglePendingUserInputOptionSelection(multi, two, "two");
    expect(buildPendingUserInputAnswers([multi], { q: empty })).toBeNull();
  });

  it("prefers allowed custom text and treats ordinary blank drafts as unanswered", () => {
    expect(
      buildPendingUserInputAnswers([question], {
        q: { selectedOptionValues: ["two"], customAnswer: "  Other\n" },
      }),
    ).toEqual({ q: "Other" });
    expect(resolvePendingUserInputAnswer(question, { customAnswer: " \t\n" })).toBeNull();
    const blank = setPendingUserInputCustomAnswer({ selectedOptionValues: ["two"] }, " \t");
    expect(buildPendingUserInputAnswers([question], { q: blank })).toEqual({ q: "two" });
    const custom = setPendingUserInputCustomAnswer(blank, "Other");
    const selection = togglePendingUserInputOptionSelection(question, custom, "  exact\t");
    expect(buildPendingUserInputAnswers([question], { q: selection })).toEqual({ q: "  exact\t" });
  });

  it.each([false, true])(
    "preserves initial-answer whitespace and intentional emptiness (multi=%s)",
    (multiSelect) => {
      const initial = { ...question, multiSelect, initialAnswer: "" };
      expect(
        buildPendingUserInputAnswers([initial], seedUserInputDraftAnswers([initial], {})),
      ).toEqual({ q: "" });
      expect(buildPendingUserInputAnswers([initial], { q: { customAnswer: " \t\n" } })).toEqual({
        q: " \t\n",
      });
      expect(buildPendingUserInputAnswers([initial], {})).toBeNull();
    },
  );

  it.each([false, true])(
    "retains chat attachment blocking and attachment-only answers (multi=%s)",
    (multiSelect) => {
      const withAttachments = { ...question, multiSelect };
      expect(
        resolvePendingUserInputAnswer(withAttachments, {
          customAnswer: "Answer",
          attachmentCount: 1,
          attachmentsBlocked: true,
        }),
      ).toBeNull();
      expect(
        buildPendingUserInputAnswers([withAttachments], { q: { attachmentCount: 1 } }),
      ).toEqual({ q: "" });
      expect(
        buildPendingUserInputAnswers([{ ...withAttachments, allowCustomAnswer: false }], {
          q: { attachmentCount: 1 },
        }),
      ).toBeNull();
    },
  );
});
