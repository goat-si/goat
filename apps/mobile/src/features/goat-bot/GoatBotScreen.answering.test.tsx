import "./goatBotScreenTestHarness";
import { act } from "react";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it } from "vite-plus/test";

import { bot, render, screenSession, typeInto } from "./goatBotScreenTestHarness";
import { GoatBotScreen } from "./GoatBotScreen";

const asked = (options: string[], ids = true): GoatBotRow => ({
  ...bot,
  id: "ask",
  text: "Which cache should the build use?",
  tone: "question",
  options,
  choices: ["Keep", "Clear"],
  ...(ids ? { answerTaskId: "task-1", answerQuestionId: "q1" } : {}),
});

async function open(row: GoatBotRow) {
  screenSession.rows = [row];
  screenSession.send.mockClear();
  screenSession.answer.mockClear();
  screenSession.answer.mockImplementation(() => true);
  const view = await render(<GoatBotScreen visible />);
  const button = (label: string) =>
    [...view.container.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === label,
    );
  const press = (label: string) => act(async () => button(label)?.click());
  const chip = () => view.container.querySelector('[aria-label^="Answering: "]');
  const typed = () =>
    view.container.querySelector<HTMLInputElement>('[aria-label="Message GOAT Bot"]')?.value;
  return { view, button, press, chip, typed };
}

it("answers its question from Something else: the chip names it, Send gives the words to its task and question", async () => {
  const { view, press, chip, typed } = await open(asked(["Keep", "Clear"]));
  try {
    await press("Something else");
    expect(chip()?.getAttribute("aria-label")).toBe("Answering: Which cache should the build use?");
    await typeInto(view.container, "Use the staging cache");
    await press("Send message");
    expect(screenSession.answer).toHaveBeenCalledWith("Use the staging cache", "task-1", "q1");
    expect(screenSession.send).not.toHaveBeenCalled();
    expect(chip()).toBeNull();
    expect(typed()).toBe("");
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});

it("keeps the chip and the words when the answer could not be sent", async () => {
  const { view, press, chip, typed } = await open(asked(["Keep", "Clear"]));
  try {
    screenSession.answer.mockImplementation(() => false);
    await press("Something else");
    await typeInto(view.container, "Use the staging cache");
    await press("Send message");
    expect(chip()).not.toBeNull();
    expect(typed()).toBe("Use the staging cache");
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});

it("goes back to a plain message once the person stops answering", async () => {
  const { view, press, chip } = await open(asked(["Keep", "Clear"]));
  try {
    await press("Something else");
    await press("Stop answering");
    expect(chip()).toBeNull();
    await typeInto(view.container, "Unrelated question");
    await press("Send message");
    expect(screenSession.send).toHaveBeenCalledWith("Unrelated question", []);
    expect(screenSession.answer).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});

it("lets go for good when the question closes, so a later message is never sent to its task", async () => {
  const { view, press, chip } = await open(asked(["Keep", "Clear"]));
  try {
    await press("Something else");
    screenSession.rows = [asked([])];
    await view.rerender(<GoatBotScreen visible />);
    expect(chip()).toBeNull();
    // The same question asking again does not bring the old answer target back.
    screenSession.rows = [asked(["Keep", "Clear"])];
    await view.rerender(<GoatBotScreen visible />);
    expect(chip()).toBeNull();
    await typeInto(view.container, "Later message");
    await press("Send message");
    expect(screenSession.send).toHaveBeenCalledWith("Later message", []);
    expect(screenSession.answer).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});

it("takes a plain message from Something else on a question no task asked", async () => {
  const { view, press, chip } = await open(asked(["Keep", "Clear"], false));
  try {
    await press("Something else");
    expect(chip()).toBeNull();
    await typeInto(view.container, "Neither");
    await press("Send message");
    expect(screenSession.send).toHaveBeenCalledWith("Neither", []);
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});
