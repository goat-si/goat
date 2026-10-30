import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Preferences } from "../../persistence/mobile-preferences";

vi.mock("../../state/preferences", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    mobilePreferencesAtom: Atom.make(AsyncResult.initial()).pipe(Atom.keepAlive),
    updateMobilePreferencesAtom: Atom.make(null).pipe(Atom.keepAlive),
  };
});

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  resetThreadListV2LaunchGroupSession,
  useRevealLaunchGroups,
  useThreadListV2LaunchGroups,
} from "./use-thread-list-v2-launch-groups";

type Update = { readonly transform: (current: Preferences) => Partial<Preferences> } | null;
const preferencesAtom = mobilePreferencesAtom as Atom.Writable<
  AsyncResult.AsyncResult<Preferences>
>;
const updateAtom = updateMobilePreferencesAtom as unknown as Atom.Writable<Update>;

/** One mounted thread list (Home or the tablet sidebar) reading launch group expansion. */
async function mountList(
  registry: AtomRegistry.AtomRegistry,
  selected: string | null,
  reveal: readonly string[] = [],
) {
  let groups: ReturnType<typeof useThreadListV2LaunchGroups> | undefined;
  function Groups(props: { readonly selected: string | null }) {
    const value = useThreadListV2LaunchGroups(props.selected);
    useRevealLaunchGroups(value, reveal);
    useLayoutEffect(() => {
      groups = value;
    });
    return null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const select = (next: string | null) =>
    act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Groups selected={next} />
        </RegistryContext.Provider>,
      ),
    );
  await select(selected);
  return {
    current: () => {
      if (groups === undefined) throw new Error("the list did not render");
      return groups;
    },
    collapsed: () => [...(groups?.state.routeCollapsed ?? [])],
    select,
    [Symbol.asyncDispose]: () => act(async () => root.unmount()),
  };
}

async function loadedRegistry() {
  resetThreadListV2LaunchGroupSession();
  const registry = AtomRegistry.make();
  registry.set(preferencesAtom, AsyncResult.success({}));
  return registry;
}

describe("mobile launch group expansion", () => {
  it("forgets a collapse made for a selected thread once another is selected", async () => {
    const registry = await loadedRegistry();
    await using list = await mountList(registry, "env:a");
    await act(async () => list.current().toggle("env:launcher", true, true));
    expect(list.collapsed()).toEqual(["env:launcher"]);
    await list.select("env:b");
    await list.select("env:a");
    expect(list.collapsed()).toEqual([]);
  });

  it("keeps one list's collapse while another list mounts or selects a different thread", async () => {
    const registry = await loadedRegistry();
    await using home = await mountList(registry, "env:a");
    await act(async () => home.current().toggle("env:launcher", true, true));
    await using sidebar = await mountList(registry, "env:b");
    await act(async () => sidebar.current().toggle("env:other", true, true));
    await sidebar.select("env:c");
    expect(home.collapsed()).toEqual(["env:launcher"]);
    await sidebar.select("env:a");
    expect(sidebar.collapsed()).toEqual(["env:launcher"]);
  });

  it("remembers groups opened for a selected thread once preferences finish loading", async () => {
    resetThreadListV2LaunchGroupSession();
    const registry = AtomRegistry.make();
    await using _list = await mountList(registry, "env:child", ["env:launcher"]);
    expect(registry.get(updateAtom)).toBeNull();
    await act(async () => registry.set(preferencesAtom, AsyncResult.success({})));
    const update = registry.get(updateAtom);
    expect(update?.transform({}).threadListLaunchGroupsExpanded).toEqual({ "env:launcher": true });
  });
});
