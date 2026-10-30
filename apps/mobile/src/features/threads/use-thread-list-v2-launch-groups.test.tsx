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

async function renderGroups(options: {
  readonly selected: string | null;
  readonly reveal?: string[];
}) {
  resetThreadListV2LaunchGroupSession();
  const registry = AtomRegistry.make();
  let groups: ReturnType<typeof useThreadListV2LaunchGroups> | undefined;
  function Groups(props: { readonly selected: string | null }) {
    const value = useThreadListV2LaunchGroups(props.selected);
    useRevealLaunchGroups(value, options.reveal ?? []);
    useLayoutEffect(() => {
      groups = value;
    });
    return null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const show = (selected: string | null) =>
    act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Groups selected={selected} />
        </RegistryContext.Provider>,
      ),
    );
  await show(options.selected);
  const current = () => {
    if (groups === undefined) throw new Error("the hook did not render");
    return groups;
  };
  return {
    registry,
    current,
    show,
    [Symbol.asyncDispose]: () => act(async () => root.unmount()),
  };
}

describe("mobile launch group expansion", () => {
  it("forgets a collapse made for one selected thread once another is selected", async () => {
    await using view = await renderGroups({ selected: "env:a" });
    await act(async () => view.registry.set(preferencesAtom, AsyncResult.success({})));
    await act(async () => view.current().toggle("env:launcher", true, true));
    expect([...view.current().state.routeCollapsed]).toEqual(["env:launcher"]);
    await view.show("env:b");
    await view.show("env:a");
    expect([...view.current().state.routeCollapsed]).toEqual([]);
  });

  it("remembers groups opened for a selected thread once preferences finish loading", async () => {
    await using view = await renderGroups({ selected: "env:child", reveal: ["env:launcher"] });
    expect(view.registry.get(updateAtom)).toBeNull();
    await act(async () => view.registry.set(preferencesAtom, AsyncResult.success({})));
    const update = view.registry.get(updateAtom);
    expect(update?.transform({}).threadListLaunchGroupsExpanded).toEqual({ "env:launcher": true });
  });
});
