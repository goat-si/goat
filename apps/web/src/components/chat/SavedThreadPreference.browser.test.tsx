import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  MemoryId,
  MemorySpaceId,
  ThreadId,
  type SavedThreadPreference as Saved,
} from "@goat/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { SavedThreadPreference } from "./SavedThreadPreference";

const preference = Atom.family((_threadId: ThreadId) => Atom.make<Saved>(null));
vi.mock("../../state/memory", () => ({
  memoryEnvironment: {
    savedThreadPreference: ({ threadId }: { threadId: ThreadId }) => preference(threadId),
  },
}));
vi.mock("gt-react", () => ({ useGT: () => (text: string) => text }));

it("links the source chat to one current entry and clears it on revocation or a thread switch", async () => {
  const registry = AtomRegistry.make();
  const environmentId = EnvironmentId.make("source-device");
  const source = ThreadId.make("source-thread");
  const saved = {
    memorySpaceId: MemorySpaceId.make("00000000-0000-4000-8000-000000000001"),
    memoryId: MemoryId.make("00000000-0000-4000-8000-000000000002"),
  };
  const ui = (threadId: ThreadId) => (
    <RegistryContext value={registry}>
      <SavedThreadPreference thread={{ environmentId, threadId }} />
    </RegistryContext>
  );
  await using screen = await render(ui(source));
  expect(screen.container.textContent).toBe("");
  await act(() => registry.set(preference(source), saved));
  const link = screen.getByRole("link", { name: "View" });
  await expect.element(link).toBeVisible();
  const href = new URL(link.element().getAttribute("href")!, window.location.href);
  expect(href.pathname).toBe("/settings/memory");
  expect(Object.fromEntries(href.searchParams)).toEqual({
    environmentId,
    machine: environmentId,
    ...saved,
  });
  await act(() => registry.set(preference(source), { ...saved }));
  expect(screen.container.querySelectorAll("a")).toHaveLength(1);
  await screen.rerender(ui(ThreadId.make("other-thread")));
  expect(screen.container.textContent).toBe("");
  await screen.rerender(ui(source));
  await act(() => registry.set(preference(source), saved));
  await expect.element(link).toBeVisible();
  await act(() => registry.set(preference(source), null));
  expect(screen.container.textContent).toBe("");
});
