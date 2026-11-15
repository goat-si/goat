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

// The draft belongs to the bot, task and destination it is written for. Each test re-renders the
// same mounted screen, as a split layout does when another bot or task is selected beside it.
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

function setup(destination: { environmentId: string; threadId: string } | null) {
  setupComposer();
  screenSession.rows = [];
  screenSession.supportsTaskThreads = false;
  screenSession.send.mockClear();
  screenSession.answer.mockClear();
  move(destination);
}

/** Where the session sends; it can send only once it has one, as the real session does. */
function move(destination: { environmentId: string; threadId: string } | null) {
  screenSession.environmentId = destination?.environmentId ?? null;
  screenSession.threadId = destination?.threadId ?? null;
  screenSession.sending = undefined;
  composer.canSend = destination !== null;
}

/** A reconnect before the bot confirms again: history shows the saved reference, nothing sends. */
function unconfirmed(saved: { environmentId: string; threadId: string }) {
  screenSession.environmentId = saved.environmentId;
  screenSession.threadId = saved.threadId;
  screenSession.sending = null;
  composer.canSend = false;
}

async function open(element: ReactNode) {
  const view = await render(element);
  const button = (label: string) =>
    [...view.container.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === label,
    );
  return {
    view,
    button,
    press: (label: string) => act(async () => button(label)?.click()),
    typed: () =>
      view.container.querySelector<HTMLInputElement>('[aria-label="Message GOAT Bot"]')?.value,
    /** New routine goes in only when the box holds no words or files. */
    boxIsEmpty: async () => {
      composer.alert.mockClear();
      await act(async () => button("Add to message: New routine")?.click());
      const empty = composer.alert.mock.calls.length === 0;
      await typeInto(view.container, "");
      return empty;
    },
    close: async () => {
      await view.unmount();
      screenSession.rows = [];
      screenSession.supportsTaskThreads = false;
      move(null);
    },
  };
}

const main = { environmentId: "env", threadId: "main-thread" };

it("text typed for GOAT Bot is cleared when the same chat moves to member Scout, and Send is not offered", async () => {
  setup(main);
  const chat = await open(<GoatBotScreen visible />);
  try {
    await typeInto(chat.view.container, "For GOAT Bot");
    move({ environmentId: "env", threadId: "scout-thread" });
    await chat.view.rerender(<GoatBotScreen visible member={scout} />);
    expect(chat.typed()).toBe("");
    expect(chat.button("Send message")).toBeUndefined();
  } finally {
    await chat.close();
  }
});

it("moving from task A to task B clears the text and releases the file in the box", async () => {
  setup(main);
  screenSession.supportsTaskThreads = true;
  const chat = await open(<GoatBotScreen visible taskId={ChannelTaskId.make("task-a")} />);
  try {
    await typeInto(chat.view.container, "About task A");
    await act(async () => picker.onPicked?.([file]));
    await chat.view.rerender(<GoatBotScreen visible taskId={ChannelTaskId.make("task-b")} />);
    expect(chat.typed()).toBe("");
    expect(picker.release).toHaveBeenCalledWith([file]);
  } finally {
    await chat.close();
  }
});

it("a different destination for the same bot, as after a Home move or a new confirmation, drops the draft", async () => {
  setup(main);
  const chat = await open(<GoatBotScreen visible />);
  try {
    await typeInto(chat.view.container, "For the old computer");
    await chat.press("Add to message: Photo Library");
    await act(async () => picker.settle?.([file]));
    move({ environmentId: "env-2", threadId: "main-thread-2" });
    await chat.view.rerender(<GoatBotScreen visible />);
    expect(chat.typed()).toBe("");
    expect(picker.release).toHaveBeenCalledWith([file]);
  } finally {
    await chat.close();
  }
});

it("before its destination first resolves the box takes no text, and once it resolves a draft stays", async () => {
  setup(null);
  const chat = await open(<GoatBotScreen visible />);
  const box = () =>
    chat.view.container.querySelector<HTMLInputElement>('[aria-label="Message GOAT Bot"]');
  try {
    expect(chat.typed()).toBe("");
    expect(box()?.readOnly).toBe(true);
    move(main);
    await chat.view.rerender(<GoatBotScreen visible />);
    expect(box()?.readOnly).toBe(false);
    await typeInto(chat.view.container, "Now it can send");
    await chat.view.rerender(<GoatBotScreen visible />);
    expect(chat.typed()).toBe("Now it can send");
  } finally {
    await chat.close();
  }
});

it("a draft survives the destination going missing and coming back the same, and a reconfirmed destination", async () => {
  setup(main);
  const chat = await open(<GoatBotScreen visible />);
  try {
    await typeInto(chat.view.container, "Still mine");
    await chat.press("Add to message: Photo Library");
    await act(async () => picker.settle?.([file]));
    move(null);
    await chat.view.rerender(<GoatBotScreen visible />);
    move(main);
    await chat.view.rerender(<GoatBotScreen visible />);
    // The saved reference shows first, then confirmation reports the same one.
    await chat.view.rerender(<GoatBotScreen visible />);
    expect(chat.typed()).toBe("Still mine");
    expect(picker.release).not.toHaveBeenCalled();
    await chat.press("Send message");
    expect(screenSession.send).toHaveBeenCalledWith("Still mine", [file]);
  } finally {
    await chat.close();
  }
});

it("a reconnect that shows a different saved reference until the bot confirms again keeps the draft", async () => {
  setup(main);
  const chat = await open(<GoatBotScreen visible />);
  try {
    await typeInto(chat.view.container, "Still mine");
    await chat.press("Add to message: Photo Library");
    await act(async () => picker.settle?.([file]));
    // A saved reference that lags the confirmed one, as after a failed preferences write.
    unconfirmed({ environmentId: "env", threadId: "older-main-thread" });
    await chat.view.rerender(<GoatBotScreen visible />);
    move(main);
    await chat.view.rerender(<GoatBotScreen visible />);
    expect(chat.typed()).toBe("Still mine");
    expect(picker.release).not.toHaveBeenCalled();
    await chat.press("Send message");
    expect(screenSession.send).toHaveBeenCalledWith("Still mine", [file]);
  } finally {
    await chat.close();
  }
});

it("a re-render for the same bot, task and destination keeps the draft", async () => {
  setup(main);
  screenSession.supportsTaskThreads = true;
  const task = ChannelTaskId.make("task-a");
  const chat = await open(<GoatBotScreen visible taskId={task} taskTitle="Old title" />);
  try {
    await typeInto(chat.view.container, "Keep me");
    await chat.view.rerender(<GoatBotScreen visible taskId={task} taskTitle="New title" />);
    expect(chat.typed()).toBe("Keep me");
  } finally {
    await chat.close();
  }
});

it("a pick that answered just before the switch joined the old draft, and the switch releases it; the same file can then join the new chat", async () => {
  setup(main);
  const chat = await open(<GoatBotScreen visible />);
  try {
    await chat.press("Add to message: Photo Library");
    await act(async () => picker.settle?.([file]));
    move({ environmentId: "env", threadId: "scout-thread" });
    await chat.view.rerender(<GoatBotScreen visible member={scout} />);
    expect(picker.release).toHaveBeenCalledWith([file]);
    expect(await chat.boxIsEmpty()).toBe(true);
    // The same file id again, now in Scout's chat: accepted, so the old one no longer counts.
    await chat.press("Add to message: Photo Library");
    await act(async () => picker.settle?.([file]));
    expect(await chat.boxIsEmpty()).toBe(false);
  } finally {
    await chat.close();
  }
});

it("Send right after the destination changed sends nothing written for the old one", async () => {
  setup(main);
  const chat = await open(<GoatBotScreen visible />);
  try {
    await typeInto(chat.view.container, "Meant for the old computer");
    await chat.press("Add to message: Photo Library");
    await act(async () => picker.settle?.([file]));
    move({ environmentId: "env-2", threadId: "main-thread-2" });
    await chat.view.rerender(<GoatBotScreen visible />);
    await chat.press("Send message");
    expect(screenSession.send).not.toHaveBeenCalled();
    expect(picker.release).toHaveBeenCalledWith([file]);
    await typeInto(chat.view.container, "Fresh");
    await chat.press("Send message");
    expect(screenSession.send).toHaveBeenCalledWith("Fresh", []);
  } finally {
    await chat.close();
  }
});

it("a typed answer still answers its question after a reconnect whose saved reference lacks that question", async () => {
  setup(main);
  const chat = await open(<GoatBotScreen visible />);
  screenSession.rows = [asked];
  await chat.view.rerender(<GoatBotScreen visible />);
  try {
    await act(async () =>
      chat.view.container
        .querySelector('button[aria-label="Something else"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await typeInto(chat.view.container, "Keep it");
    unconfirmed({ environmentId: "env", threadId: "older-main-thread" });
    screenSession.rows = [];
    await chat.view.rerender(<GoatBotScreen visible />);
    move(main);
    screenSession.rows = [asked];
    await chat.view.rerender(<GoatBotScreen visible />);
    expect(chat.view.container.querySelector('[aria-label^="Answering: "]')).not.toBeNull();
    await chat.press("Send message");
    expect(screenSession.send).not.toHaveBeenCalled();
    expect(screenSession.answer).toHaveBeenCalledWith("Keep it", "task-ask", "q-ask");
  } finally {
    await chat.close();
  }
});

it("a question that closed during a reconnect keeps its chip while nothing can send, then ends answering and the words stay", async () => {
  setup(main);
  const chat = await open(<GoatBotScreen visible />);
  screenSession.rows = [asked];
  await chat.view.rerender(<GoatBotScreen visible />);
  const chip = () => chat.view.container.querySelector('[aria-label^="Answering: "]');
  try {
    await act(async () =>
      chat.view.container
        .querySelector('button[aria-label="Something else"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await typeInto(chat.view.container, "Keep it");
    unconfirmed({ environmentId: "env", threadId: "older-main-thread" });
    screenSession.rows = [];
    await chat.view.rerender(<GoatBotScreen visible />);
    expect(chip()).not.toBeNull();
    move(main);
    screenSession.rows = [{ ...asked, options: [], choices: [] }];
    await chat.view.rerender(<GoatBotScreen visible />);
    expect(chip()).toBeNull();
    expect(chat.typed()).toBe("Keep it");
    await chat.press("Send message");
    expect(screenSession.answer).not.toHaveBeenCalled();
    expect(screenSession.send).toHaveBeenCalledWith("Keep it", []);
  } finally {
    await chat.close();
  }
});

it("answering ends and its typed answer clears when the destination changes, even with the same question still listed", async () => {
  setup(main);
  const chat = await open(<GoatBotScreen visible />);
  screenSession.rows = [asked];
  await chat.view.rerender(<GoatBotScreen visible />);
  try {
    await act(async () =>
      chat.view.container
        .querySelector('button[aria-label="Something else"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(chat.view.container.querySelector('[aria-label^="Answering: "]')).not.toBeNull();
    await typeInto(chat.view.container, "Keep it");
    move({ environmentId: "env-2", threadId: "main-thread-2" });
    await chat.view.rerender(<GoatBotScreen visible />);
    expect(chat.view.container.querySelector('[aria-label^="Answering: "]')).toBeNull();
    expect(chat.typed()).toBe("");
    await typeInto(chat.view.container, "A new message");
    await chat.press("Send message");
    expect(screenSession.answer).not.toHaveBeenCalled();
    expect(screenSession.send).toHaveBeenCalledWith("A new message", []);
  } finally {
    await chat.close();
  }
});

vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));
