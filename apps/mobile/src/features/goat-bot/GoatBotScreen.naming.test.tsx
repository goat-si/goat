import "./goatBotScreenTestHarness";
import { act } from "react";
import type { BotProfile } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

import { bot, botEditing, render, screenSession } from "./goatBotScreenTestHarness";
import { GoatBotScreen } from "./GoatBotScreen";

const memberNamed = (botId: string, name: string, extra: object = {}) =>
  ({
    botId,
    name,
    role: "member",
    environmentId: "env",
    sessionThreadId: `${botId}-thread`,
    state: "active",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    ...extra,
  }) as unknown as BotProfile;

async function open(
  member: BotProfile | undefined,
  options: { canEdit?: boolean; rows?: GoatBotRow[] } = {},
) {
  botEditing.canEdit = options.canEdit ?? true;
  botEditing.update.mockReset();
  botEditing.update.mockImplementation(async () => null);
  botEditing.sheet = null;
  screenSession.rows = options.rows ?? [];
  const view = await render(<GoatBotScreen visible member={member} />);
  // This device's dismissals are read once, after the first render.
  await act(async () => {});
  const field = () =>
    view.container.querySelector<HTMLInputElement>('input[aria-label="Bot name"]');
  const button = (label: string) =>
    [...view.container.querySelectorAll("button")].find(
      (item) => item.textContent === label || item.getAttribute("aria-label") === label,
    );
  const press = (label: string) => act(async () => button(label)?.click());
  const type = (value: string) =>
    act(async () => {
      const input = field();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  return { view, field, button, press, type };
}

it("asks for a name above the message box while a member still has a generated name, and nowhere else", async () => {
  const fresh = await open(memberNamed("fresh", "New bot 2"));
  const field = fresh.field();
  expect(field?.value).toBe("New bot 2");
  const box = fresh.view.container.querySelector('input[aria-label="Message GOAT Bot"]');
  expect(
    field && box ? field.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING : 0,
  ).toBeTruthy();
  await fresh.view.unmount();
  for (const [member, canEdit] of [
    [memberNamed("named", "Ada"), true],
    [undefined, true],
    [memberNamed("gone", "New bot", { state: "deleted" }), true],
    [memberNamed("locked", "New bot"), false],
  ] as const) {
    const other = await open(member, { canEdit });
    expect(other.field()).toBeNull();
    await other.view.unmount();
  }
});

it("renames the bot from the row, keeps Done off for a blank name, and keeps the row with the reason when the save fails", async () => {
  const member = memberNamed("rename", "New bot");
  const row = await open(member);
  await row.type("   ");
  expect(row.button("Done")?.hasAttribute("disabled")).toBe(true);
  await row.type("Ada");
  botEditing.update.mockImplementationOnce(async () => "You can't change this bot.");
  await row.press("Done");
  expect(botEditing.update).toHaveBeenLastCalledWith(member, { name: "Ada" });
  expect(row.view.container.textContent).toContain("You can't change this bot.");
  expect(row.field()?.value).toBe("Ada");
  await row.press("Done");
  // The list now holds the new name: the bot has a real name and the row goes.
  await row.view.rerender(<GoatBotScreen visible member={{ ...member, name: "Ada" }} />);
  expect(row.field()).toBeNull();
  await row.view.unmount();
});

it("leaves an unchanged name alone: Done sends nothing and the row stays", async () => {
  const row = await open(memberNamed("same", "New bot 4"));
  await row.press("Done");
  expect(botEditing.update).not.toHaveBeenCalled();
  expect(row.field()).not.toBeNull();
  await row.view.unmount();
});

it("hides the row for good on this device once dismissed, for that bot only", async () => {
  const dismissed = memberNamed("dismissed", "New bot");
  const row = await open(dismissed);
  await row.press("Dismiss naming");
  expect(row.field()).toBeNull();
  expect(botEditing.writes.at(-1)).toContain("dismissed");
  await row.view.unmount();
  const again = await open(dismissed);
  expect(again.field()).toBeNull();
  await again.view.unmount();
  const other = await open(memberNamed("other", "New bot"));
  expect(other.field()).not.toBeNull();
  await other.view.unmount();
});

it("carries the typed name into Edit bot from More, and Cancel there returns to the row with it", async () => {
  const row = await open(memberNamed("more", "New bot"));
  await row.type("Ada");
  await row.press("More");
  expect(botEditing.sheet).toMatchObject({ botId: "more", draftName: "Ada" });
  await act(async () => botEditing.sheet?.onClose());
  expect(row.view.container.querySelector('[role="dialog"]')).toBeNull();
  expect(row.field()?.value).toBe("Ada");
  await row.view.unmount();
});

it("offers Edit bot in the home sheet for a member that can be edited, opening it once the sheet has gone", async () => {
  const row = await open(memberNamed("home", "Scout"));
  expect(screenSession.editBot).not.toBeNull();
  await act(async () => screenSession.editBot?.());
  expect(botEditing.sheet).toBeNull();
  await act(async () => screenSession.homeGone?.());
  expect(botEditing.sheet).toMatchObject({ botId: "home" });
  await row.view.unmount();
  for (const member of [undefined, memberNamed("deleted", "Scout", { state: "deleted" })]) {
    const other = await open(member);
    expect(screenSession.editBot).toBeNull();
    await other.view.unmount();
  }
});

it("shows the name row and the answering chip together, the name row first", async () => {
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
  const row = await open(memberNamed("both", "New bot"), { rows: [asked] });
  await act(async () =>
    row.view.container
      .querySelector('button[aria-label="Something else"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  const chip = row.view.container.querySelector('[aria-label^="Answering: "]');
  const field = row.field();
  expect(chip).not.toBeNull();
  expect(
    field && chip ? field.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING : 0,
  ).toBeTruthy();
  await row.view.unmount();
});

vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));
