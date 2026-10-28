import { expect, it } from "vite-plus/test";
import { fillNote, popupOwner, POPUP_ATTRIBUTION_MS, renderedViewport } from "./agentTabState.ts";

it("gives a popup to the agent whose input on an unowned tab opened it", () => {
  const input = { agentId: "agent-a", at: 1_000 };
  expect(
    popupOwner({ ownerId: "owner", agentOperating: false, lastAgentInput: input }, 1_000),
  ).toBe("owner");
  expect(popupOwner({ ownerId: null, agentOperating: true, lastAgentInput: input }, 99_000)).toBe(
    "agent-a",
  );
  expect(
    popupOwner({ ownerId: null, agentOperating: false, lastAgentInput: input }, 1_000 + 500),
  ).toBe("agent-a");
  // A person's click long after the agent's last input opens a person's popup.
  expect(
    popupOwner(
      { ownerId: null, agentOperating: false, lastAgentInput: input },
      1_000 + POPUP_ATTRIBUTION_MS,
    ),
  ).toBeNull();
  expect(popupOwner({ ownerId: null, agentOperating: false }, 1_000)).toBeNull();
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
