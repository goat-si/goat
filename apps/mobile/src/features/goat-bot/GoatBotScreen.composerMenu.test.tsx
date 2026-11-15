import "./goatBotScreenTestHarness";
import { act, type ReactNode } from "react";
import { ChannelTaskId, type BotProfile } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

import {
  bot,
  composer,
  picker,
  render,
  screenSession,
  setupComposer,
  typeInto,
} from "./goatBotScreenTestHarness";
import { GoatBotScreen } from "./GoatBotScreen";

const ROUTINE = "Set up a routine: ";
const file = {
  id: "report",
  type: "file" as const,
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 4,
  fileUri: "file:///documents/report.pdf",
};
const asked: GoatBotRow = {
  ...bot,
  id: "ask",
  text: "Which cache should the build use?",
  tone: "question",
  options: ["Keep", "Clear"],
  choices: ["Keep", "Clear"],
  answerTaskId: "task-ask",
  answerQuestionId: "q-ask",
};

async function open(element?: ReactNode, rows: GoatBotRow[] = []) {
  screenSession.rows = rows;
  const view = await render(element ?? <GoatBotScreen visible />);
  const buttons = () => [...view.container.querySelectorAll("button")];
  const button = (label: string) =>
    buttons().find((item) => item.getAttribute("aria-label") === label);
  const press = (label: string) => act(async () => button(label)?.click());
  /** What the chat's + offers, in its order. */
  const menu = () =>
    buttons()
      .map((item) => item.getAttribute("aria-label") ?? "")
      .filter((label) => label.startsWith("Add to message: "))
      .map((label) => label.slice("Add to message: ".length));
  const typed = () =>
    view.container.querySelector<HTMLInputElement>('[aria-label="Message GOAT Bot"]')?.value;
  const chip = () => view.container.querySelector('[aria-label^="Answering: "]');
  const close = async () => {
    await view.unmount();
    screenSession.rows = [];
  };
  return { view, button, press, menu, typed, chip, close };
}

it("offers photos, files and New routine from the chat's +, and New routine fills the empty box", async () => {
  setupComposer();
  composer.support = { maxUploadBytes: 10_000_000 };
  const chat = await open();
  try {
    expect(chat.button("Add to message")).toBeDefined();
    expect(chat.menu()).toEqual(["Photo Library", "Choose Files", "New routine"]);
    await chat.press("Add to message: New routine");
    expect(chat.typed()).toBe(ROUTINE);
    expect(composer.alert).not.toHaveBeenCalled();
  } finally {
    await chat.close();
  }
});

it("on a server that takes no attachments, the + still offers New routine", async () => {
  setupComposer();
  composer.support = null;
  const chat = await open();
  try {
    expect(chat.menu()).toEqual(["New routine"]);
  } finally {
    await chat.close();
  }
});

it("on a server that takes photos only, the + offers Photo Library and New routine", async () => {
  setupComposer();
  const chat = await open();
  try {
    expect(chat.menu()).toEqual(["Photo Library", "New routine"]);
    await chat.press("Add to message: Photo Library");
    expect(picker.picks).toEqual(["media"]);
  } finally {
    await chat.close();
  }
});

it("New routine from the + while answering with nothing typed starts the request and ends answering", async () => {
  setupComposer();
  const chat = await open(<GoatBotScreen visible />, [asked]);
  try {
    await act(async () =>
      chat.view.container
        .querySelector('button[aria-label="Something else"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(chat.chip()).not.toBeNull();
    await chat.press("Add to message: New routine");
    expect(chat.typed()).toBe(ROUTINE);
    expect(chat.chip()).toBeNull();
  } finally {
    await chat.close();
  }
});

it("a member's chat offers New routine and drafts into the member's own box", async () => {
  setupComposer();
  const scout = {
    botId: "scout",
    name: "Scout",
    emoji: "S",
    color: "#2F6FED",
    avatar: null,
    environmentId: "env",
    sessionThreadId: "scout-thread",
    state: "active",
  } as unknown as BotProfile;
  const chat = await open(<GoatBotScreen visible member={scout} />);
  try {
    expect(chat.menu()).toContain("New routine");
    await chat.press("Add to message: New routine");
    expect(chat.typed()).toBe(ROUTINE);
  } finally {
    await chat.close();
  }
});

it("a pick still open keeps New routine out of the box until it answers", async () => {
  setupComposer();
  const chat = await open();
  try {
    await chat.press("Add to message: Photo Library");
    await chat.press("Add to message: New routine");
    expect(composer.alert).toHaveBeenCalledTimes(1);
    expect(chat.typed()).toBe("");
    await act(async () => picker.settle?.([]));
    await chat.press("Add to message: New routine");
    expect(chat.typed()).toBe(ROUTINE);
  } finally {
    await chat.close();
  }
});

it("a pick that answers after the chat lost focus is released, and the box is free again", async () => {
  setupComposer();
  const chat = await open();
  try {
    await chat.press("Add to message: Photo Library");
    await chat.view.rerender(<GoatBotScreen visible={false} />);
    await act(async () => picker.settle?.([file]));
    expect(picker.release).toHaveBeenCalledWith([file]);
    await chat.view.rerender(<GoatBotScreen visible />);
    expect(chat.view.container.textContent).not.toContain("report.pdf");
    await chat.press("Add to message: New routine");
    expect(chat.typed()).toBe(ROUTINE);
  } finally {
    await chat.close();
  }
});

it("Home's New routine is refused while the box holds text or a file, and keeps them", async () => {
  setupComposer();
  const chat = await open();
  try {
    await typeInto(chat.view.container, "Half a thought");
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = screenSession.draft?.(ROUTINE);
    });
    expect(accepted).toBe(false);
    expect(composer.alert).toHaveBeenCalledTimes(1);
    expect(chat.typed()).toBe("Half a thought");
    await typeInto(chat.view.container, "");
    await act(async () => picker.onPicked?.([file]));
    await act(async () => {
      accepted = screenSession.draft?.(ROUTINE);
    });
    expect(accepted).toBe(false);
    expect(composer.alert).toHaveBeenCalledTimes(2);
    expect(chat.typed()).toBe("");
  } finally {
    await chat.close();
  }
});

it("Home's New routine is refused while an answer is typed, and answering stays", async () => {
  setupComposer();
  const chat = await open(<GoatBotScreen visible />, [asked]);
  try {
    await act(async () =>
      chat.view.container
        .querySelector('button[aria-label="Something else"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await typeInto(chat.view.container, "Use the staging cache");
    await act(async () => {
      screenSession.draft?.(ROUTINE);
    });
    expect(composer.alert).toHaveBeenCalledTimes(1);
    expect(chat.typed()).toBe("Use the staging cache");
    expect(chat.chip()).not.toBeNull();
  } finally {
    await chat.close();
  }
});

it("while the chat cannot send, its + is dimmed, says why and opens nothing; with no attachments there is none", async () => {
  setupComposer();
  composer.canSend = false;
  const dimmed = await open();
  try {
    const plus = dimmed.button("Add to message");
    expect(plus?.disabled).toBe(true);
    expect(plus?.getAttribute("data-hint")).toBe("Opens once this chat can send messages again.");
    expect(dimmed.menu()).toEqual([]);
  } finally {
    await dimmed.close();
  }
  composer.support = null;
  const none = await open();
  try {
    expect(none.button("Add to message")).toBeUndefined();
  } finally {
    await none.close();
  }
});

it("a task's own screen keeps its attach button and has no New routine", async () => {
  setupComposer();
  screenSession.supportsTaskThreads = true;
  const task = await open(<GoatBotScreen visible taskId={ChannelTaskId.make("task-1")} />);
  try {
    expect(task.button("Add attachment")).toBeDefined();
    expect(task.button("Add to message")).toBeUndefined();
  } finally {
    await task.close();
    screenSession.supportsTaskThreads = false;
  }
});

it("the chat's + menu is taken down while Home covers the chat, the chat loses focus or the app is in the background", async () => {
  setupComposer();
  const chat = await open();
  try {
    expect(chat.menu()).toEqual(["Photo Library", "New routine"]);
    await chat.view.rerender(<GoatBotScreen visible foreground={false} />);
    expect(chat.menu()).toEqual([]);
    expect(chat.button("Add to message")).toBeDefined();
    await chat.view.rerender(<GoatBotScreen visible={false} />);
    expect(chat.menu()).toEqual([]);
    await chat.view.rerender(<GoatBotScreen visible />);
    expect(chat.menu()).toEqual(["Photo Library", "New routine"]);
    await chat.press("Chip GOAT Bot");
    expect(screenSession.homeOpen).toBe(true);
    expect(chat.menu()).toEqual([]);
  } finally {
    await chat.close();
  }
});

it("New routine treats a box with only blank space as empty, and keeps a box with words", async () => {
  setupComposer();
  const chat = await open();
  try {
    await typeInto(chat.view.container, "  \n ");
    await chat.press("Add to message: New routine");
    expect(chat.typed()).toBe(ROUTINE);
    expect(composer.alert).not.toHaveBeenCalled();
    await typeInto(chat.view.container, "Half a thought");
    await chat.press("Add to message: New routine");
    expect(chat.typed()).toBe("Half a thought");
    expect(composer.alert).toHaveBeenCalledTimes(1);
  } finally {
    await chat.close();
  }
});

it("a pick still open when the reused chat moves to another bot or computer is released, and the next chat's box stays free", async () => {
  const scout = {
    botId: "scout",
    name: "Scout",
    emoji: "S",
    color: "#2F6FED",
    avatar: null,
    environmentId: "env",
    sessionThreadId: "scout-thread",
    state: "active",
  } as unknown as BotProfile;
  for (const next of [
    { member: scout, environmentId: "env", threadId: "scout-thread" },
    { member: undefined, environmentId: "env-2", threadId: "main-thread" },
  ]) {
    setupComposer();
    screenSession.environmentId = "env";
    screenSession.threadId = "main-thread";
    const chat = await open();
    try {
      await chat.press("Add to message: Photo Library");
      screenSession.environmentId = next.environmentId;
      screenSession.threadId = next.threadId;
      await chat.view.rerender(<GoatBotScreen visible member={next.member} />);
      await act(async () => picker.settle?.([file]));
      expect(picker.release).toHaveBeenCalledWith([file]);
      await chat.press("Add to message: New routine");
      expect(chat.typed()).toBe(ROUTINE);
      expect(composer.alert).not.toHaveBeenCalled();
    } finally {
      await chat.close();
      screenSession.environmentId = null;
      screenSession.threadId = null;
    }
  }
});

vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));
