import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { GoatBotQuestionCard } from "./GoatBotQuestionCard";

const question: Extract<GoatBotRow, { kind: "bot" }> = {
  kind: "bot",
  id: "q",
  text: "Short or detailed?",
  createdAt: "2026-11-11T00:00:00Z",
  tone: "question",
  proactive: false,
  replyTo: null,
  options: ["Short summary", "Detailed summary"],
  choices: ["Short summary", "Detailed summary"],
  answerTaskId: "task-1",
  firstInGroup: true,
  groupPosition: "single",
};

it("sends a lettered choice, or what the person types as something else, to the question's task", async () => {
  const onPick = vi.fn<(answer: string, taskId?: string) => void>();
  await using screen = await render(
    <GoatBotQuestionCard row={question} body={question.text} onPick={onPick} />,
    { router: false }, // No links inside the card.
  );
  await expect.element(screen.getByRole("button", { name: "Short summary" })).toBeVisible();
  await screen.getByRole("button", { name: "Detailed summary" }).click();
  expect(onPick).toHaveBeenLastCalledWith("Detailed summary", "task-1");
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), "Both{Enter}");
  expect(onPick).toHaveBeenLastCalledWith("Both", "task-1");
  await expect.element(screen.getByRole("textbox", { name: "Something else" })).toHaveValue("");
});

it("keeps only the picked row once the question is answered", async () => {
  const answered = { ...question, options: [], answer: "Detailed summary", answerIndex: 1 };
  await using screen = await render(
    <GoatBotQuestionCard row={answered} body={answered.text} onPick={() => {}} />,
    { router: false }, // No links inside the card.
  );
  await expect.element(screen.getByText("You answered:")).toBeInTheDocument();
  await expect.element(screen.getByText("Detailed summary")).toBeVisible();
  expect(screen.container.textContent).not.toContain("Short summary");
  expect(screen.container.querySelectorAll("button")).toHaveLength(0);
  expect(screen.container.querySelector("input")).toBeNull();
});
