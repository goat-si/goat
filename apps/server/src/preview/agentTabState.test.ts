import { expect, it } from "vite-plus/test";
import {
  ClosedPopups,
  fillNote,
  popupOwner,
  PopupAttribution,
  POPUP_ATTRIBUTION_MS,
  renderedViewport,
  tabChoice,
} from "./agentTabState.ts";

it("gives a popup to the agent whose input on an unowned tab opened it", () => {
  const input = { agentId: "agent-a", at: 1_000, generation: 0 };
  expect(
    popupOwner(
      {
        control: { agentId: "owner", generation: 0 },
        agentOperating: false,
        lastAgentInput: input,
      },
      1_000,
    ),
  ).toBe("owner");
  expect(
    popupOwner(
      { control: { agentId: null, generation: 0 }, agentOperating: true, lastAgentInput: input },
      99_000,
    ),
  ).toBe("agent-a");
  expect(
    popupOwner(
      { control: { agentId: null, generation: 0 }, agentOperating: false, lastAgentInput: input },
      1_000 + 500,
    ),
  ).toBe("agent-a");
  // A person's click long after the agent's last input opens a person's popup.
  expect(
    popupOwner(
      { control: { agentId: null, generation: 0 }, agentOperating: false, lastAgentInput: input },
      1_000 + POPUP_ATTRIBUTION_MS,
    ),
  ).toBeNull();
  expect(
    popupOwner({ control: { agentId: null, generation: 0 }, agentOperating: false }, 1_000),
  ).toBeNull();
  // A person who took the tab since the agent's input opens a person's popup, however soon.
  expect(
    popupOwner(
      { control: { agentId: null, generation: 1 }, agentOperating: false, lastAgentInput: input },
      1_000 + 100,
    ),
  ).toBeNull();
});

it("measures a desktop page's real size and says why fill kept it", async () => {
  const cdp = {
    send: async () => ({ cssLayoutViewport: { clientWidth: 430, clientHeight: 932 } }),
  } as unknown as Parameters<typeof renderedViewport>[0];
  const size = await renderedViewport(cdp, { width: 1280, height: 800 });
  expect(size).toEqual({ width: 430, height: 932 });
  expect(fillNote({ _tag: "fill" }, size, size).next).toContain("no panel shows it");
  expect(fillNote({ _tag: "fill" }, { width: 1280, height: 800 }, size)).toEqual({});
  expect(fillNote({ _tag: "freeform", width: 430, height: 932 } as never, size, size)).toEqual({});
});

it("names the tabs to choose from instead of switching to a popup", () => {
  expect(
    tabChoice([
      { tabId: "tab_a", openerTabId: undefined },
      { tabId: "tab_b", openerTabId: "tab_a" },
    ]),
  ).toBe(
    "This agent session has several tabs: tab_a, tab_b (popup of tab_a). Pass tabId to choose one; the current tab does not change on its own.",
  );
});

it("points a closed popup's caller back to its opener, without choosing it for them", () => {
  const closed = new ClosedPopups(2);
  closed.record("thread", "tab_b", "tab_a");
  expect(closed.notFound("thread", "tab_b", new Set(["thread\u0000tab_a"]))).toMatchObject({
    message:
      "Tab tab_b, a popup, has closed. Its opener tab_a is still open: pass tabId tab_a to continue there.",
    detail: { closedPopup: { openerTabId: "tab_a", openerOpen: true } },
  });
  expect(closed.notFound("thread", "tab_b", new Set()).detail).toEqual({
    closedPopup: { openerTabId: "tab_a", openerOpen: false },
  });
  closed.record("thread", "tab_c", "tab_a");
  closed.record("thread", "tab_d", "tab_a");
  expect(closed.notFound("thread", "tab_b", new Set(["thread\u0000tab_a"])).detail).toBeUndefined();
});

it("gives a slow popup to the agent whose click opened it, though another agent acted since", () => {
  const popups = new PopupAttribution();
  const opener = { control: { agentId: null, generation: 0 }, agentOperating: true };
  popups.lastInput = { agentId: "agent-a", at: 1_000, generation: 0 };
  popups.opened(opener, 1_000);
  // The popup's first response is slow; agent B acts on the opener before it arrives.
  popups.lastInput = { agentId: "agent-b", at: 1_500, generation: 0 };
  expect(popups.owner(opener, 1_600)).toBe("agent-a");
  // A popup with no announced opening falls back to the latest input.
  expect(popups.owner(opener, 1_700)).toBe("agent-b");
  // An opening that never became a popup is forgotten.
  popups.opened(opener, 2_000);
  expect(popups.owner({ ...opener, agentOperating: false }, 2_000 + 60_000)).toBeNull();
});
