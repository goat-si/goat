import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";

import { type GoatBotVisitSnapshot, useGoatBotVisitSnapshot } from "./useGoatBotVisitSnapshot";

type Input = Parameters<typeof useGoatBotVisitSnapshot>[0];

async function mount(first: Input) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let seen: GoatBotVisitSnapshot | null = null;
  function Probe(props: Input) {
    seen = useGoatBotVisitSnapshot(props);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const show = async (input: Input) => {
    await act(async () => root.render(<Probe {...input} />));
    return seen;
  };
  await show(first);
  return { show, unmount: () => act(async () => root.unmount()) };
}

const base: Input = {
  focused: true,
  conversation: "env:bot",
  loaded: true,
  lastVisitedAt: "T1",
  newestAt: "N1",
};

it("keeps the read position the visit began with after the visit is recorded", async () => {
  const view = await mount({ ...base, loaded: false, lastVisitedAt: null });
  expect(await view.show({ ...base, loaded: false, lastVisitedAt: null })).toBeNull();
  const first = await view.show(base);
  expect(first?.readUpTo).toBe("T1");
  expect(first?.newestAtOpen).toBe("N1");
  // The route records the visit, which moves the shell's lastVisitedAt; a reply arrives.
  expect(await view.show({ ...base, lastVisitedAt: "T2", newestAt: "N2" })).toEqual(first);
  await view.unmount();
});

it("takes a new read position on each focused visit and for another conversation", async () => {
  const view = await mount(base);
  const first = await view.show(base);
  expect(await view.show({ ...base, focused: false, lastVisitedAt: "T2" })).toBeNull();
  const second = await view.show({ ...base, lastVisitedAt: "T2" });
  expect(second?.readUpTo).toBe("T2");
  expect(second?.key).not.toBe(first?.key);
  const other = await view.show({ ...base, conversation: "env:other", lastVisitedAt: "T9" });
  expect(other?.readUpTo).toBe("T9");
  await view.unmount();
});

it("tells a never-read conversation from one whose shell has not loaded", async () => {
  const view = await mount({ ...base, loaded: false, lastVisitedAt: null });
  expect(await view.show({ ...base, loaded: false, lastVisitedAt: null })).toBeNull();
  expect((await view.show({ ...base, lastVisitedAt: null }))?.readUpTo).toBeNull();
  await view.unmount();
});

it("keeps a moment away apart from the opening boundary, so a reply read before it stays read", async () => {
  const view = await mount({ ...base, reading: true });
  const opened = await view.show({ ...base, reading: true });
  // A reply arrives and is read in the chat; then Control Center opens and another reply comes.
  await view.show({ ...base, reading: true, lastVisitedAt: "T2", newestAt: "N2" });
  await view.show({ ...base, reading: false, lastVisitedAt: "T2", newestAt: "N2" });
  const away = await view.show({ ...base, reading: false, lastVisitedAt: "T2", newestAt: "N3" });
  expect(away).toMatchObject({ key: opened?.key, readUpTo: "T1", newestAtOpen: "N1" });
  expect(away?.away).toEqual([{ after: "N2", upTo: "N3" }]);
  // Back in the chat, the moment away is kept; a later reply is read as it arrives.
  const back = await view.show({ ...base, reading: true, lastVisitedAt: "T3", newestAt: "N4" });
  expect(back?.away).toEqual([{ after: "N2", upTo: "N3" }]);
  await view.unmount();
});

it("counts a reply that arrives in the same moment the person steps away as unread", async () => {
  const view = await mount({ ...base, reading: true });
  await view.show({ ...base, reading: true });
  // Control Center opens as the reply lands: the person never saw N2.
  const away = await view.show({ ...base, reading: false, newestAt: "N2" });
  expect(away?.away).toEqual([{ after: "N1", upTo: "N2" }]);
  await view.unmount();
});
