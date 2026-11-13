import "./goatBotScreenTestHarness";
import { act } from "react";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

import { bot, picker, render, screenSession, typeInto } from "./goatBotScreenTestHarness";
import { GoatBotScreen } from "./GoatBotScreen";

const asked = (options: string[], ids = true, id = "ask"): GoatBotRow => ({
  ...bot,
  id,
  text: id === "ask" ? "Which cache should the build use?" : `Question ${id}?`,
  tone: "question",
  options,
  choices: ["Keep", "Clear"],
  ...(ids ? { answerTaskId: `task-${id}`, answerQuestionId: `q-${id}` } : {}),
});

async function open(...rows: GoatBotRow[]) {
  screenSession.rows = rows;
  screenSession.send.mockClear();
  screenSession.answer.mockClear();
  screenSession.answer.mockImplementation(() => true);
  const view = await render(<GoatBotScreen visible />);
  const button = (label: string) =>
    [...view.container.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === label,
    );
  const press = (label: string) => act(async () => button(label)?.click());
  /** The Something else of the nth question on screen. */
  const somethingElse = (index: number) =>
    act(async () =>
      [...view.container.querySelectorAll('button[aria-label="Something else"]')]
        .at(index)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
  const chip = () => view.container.querySelector('[aria-label^="Answering: "]');
  const typed = () =>
    view.container.querySelector<HTMLInputElement>('[aria-label="Message GOAT Bot"]')?.value;
  return { view, button, press, somethingElse, chip, typed };
}

it("answers its question from Something else: the chip names it, Send gives the words to its task and question", async () => {
  const { view, press, chip, typed } = await open(asked(["Keep", "Clear"]));
  try {
    await press("Something else");
    expect(chip()?.getAttribute("aria-label")).toBe("Answering: Which cache should the build use?");
    await typeInto(view.container, "Use the staging cache");
    await press("Send message");
    expect(screenSession.answer).toHaveBeenCalledWith("Use the staging cache", "task-ask", "q-ask");
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

it("follows the question whose Something else was used last, and none for a question no task asked", async () => {
  const { view, somethingElse, chip, press } = await open(
    asked(["Keep", "Clear"]),
    asked(["Keep", "Clear"], true, "b"),
    asked(["Keep", "Clear"], false, "c"),
  );
  try {
    await somethingElse(0);
    await somethingElse(1);
    expect(chip()?.getAttribute("aria-label")).toBe("Answering: Question b?");
    // A question no task asked takes a plain message, so the earlier target lets go.
    await somethingElse(2);
    expect(chip()).toBeNull();
    await typeInto(view.container, "Neither of them");
    await press("Send message");
    expect(screenSession.send).toHaveBeenCalledWith("Neither of them", []);
    expect(screenSession.answer).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});

it("sends a request the home drafts as its own message, never as the open answer", async () => {
  const { view, somethingElse, chip, press } = await open(asked(["Keep", "Clear"]));
  try {
    await somethingElse(0);
    expect(chip()).not.toBeNull();
    await act(async () => {
      expect(screenSession.draft?.("Set up a routine: every morning")).toBe(true);
    });
    expect(chip()).toBeNull();
    await press("Send message");
    expect(screenSession.send).toHaveBeenCalledWith("Set up a routine: every morning", []);
    expect(screenSession.answer).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});

it("lets go when the screen shows another bot's conversation", async () => {
  const { view, somethingElse, chip } = await open(asked(["Keep", "Clear"]));
  try {
    await somethingElse(0);
    expect(chip()).not.toBeNull();
    const scout = {
      botId: "scout",
      name: "Scout",
      environmentId: "env",
      sessionThreadId: "scout-thread",
      state: "active",
      avatar: null,
    } as unknown as import("@goat/contracts").BotProfile;
    await view.rerender(<GoatBotScreen visible member={scout} />);
    expect(chip()).toBeNull();
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});

it("holds an answer while files are in the box, and says so, since an answer cannot carry them", async () => {
  const { view, somethingElse, button, press } = await open(asked(["Keep", "Clear"]));
  try {
    await somethingElse(0);
    await typeInto(view.container, "Use the staging cache");
    const file = {
      id: "report",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
      fileUri: "file:///documents/report.pdf",
    };
    await act(async () => picker.onPicked?.([file]));
    expect(view.container.textContent).toContain(
      "An answer can't carry files. Remove them to send it.",
    );
    expect(button("Send message")?.disabled).toBe(true);
    await press("Send message");
    expect(screenSession.answer).not.toHaveBeenCalled();
    expect(screenSession.send).not.toHaveBeenCalled();
    // Stopping the answer sends words and files together as an ordinary message.
    await press("Stop answering");
    await press("Send message");
    expect(screenSession.send).toHaveBeenCalledWith("Use the staging cache", [file]);
  } finally {
    await view.unmount();
    screenSession.rows = [];
  }
});

vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));
