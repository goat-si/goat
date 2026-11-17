import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, MemoryItem, MemoryRevision, MemorySpaceId } from "@goat/contracts";
import { emptyMemoryExposure } from "@goat/client-runtime/state/memory";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AtomRegistry } from "effect/reactivity";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render, type Screen } from "../../../test/render";
import { readyMemoryExposure, withMemorySignal } from "../../test/memoryExposureFixture";

const state = vi.hoisted(() => ({
  version: 0,
  listeners: new Set<() => void>(),
  exposure: null as unknown as import("@goat/client-runtime/state/memory").MemoryExposure,
  write: true,
  queries: new Map<string, unknown>(),
  upsert: null as ((input: unknown) => Promise<unknown>) | null,
  calls: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
  onForgotten: vi.fn(),
}));
function useFixtureVersion() {
  useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    () => state.version,
  );
}
function fixtureValue(label: string) {
  return label === "exposure" ? state.exposure : label === "upsert" ? state.write : true;
}
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    // Fixture atoms carry a label; real atoms (the shared draft) read through the registry.
    useAtomValue: (atom: { label?: string }) => {
      if (atom.label === undefined) return actual.useAtomValue(atom as never);
      useFixtureVersion();
      return fixtureValue(atom.label);
    },
  };
});
vi.mock("../../state/memory", async () => {
  const { Atom } = await import("effect/reactivity");
  // Unlike the shared draft, this one never purges: tests purge it where the shared fence would.
  const drafts = Atom.family((_key: string) => {
    const stored = Atom.make<{ text: string } | null>(null);
    return Atom.writable(
      (get) => get(stored)?.text ?? null,
      (ctx, value: { text: string } | null) => ctx.set(stored, value),
    );
  });
  const command = (label: string) => ({ label, permissionAtom: () => ({ label }) });
  return {
    memoryEnvironment: {
      exposureAtom: () => ({ label: "exposure" }),
      read: () => ({ label: "read" }),
      history: () => ({ label: "history" }),
      upsert: command("upsert"),
      forget: command("forget"),
      draftAtom: ({ draftId }: { draftId: string }) => drafts(draftId),
    },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: ({ label }: { label: string }) => {
    useFixtureVersion();
    return { data: state.queries.get(label) ?? Option.none(), error: null, refresh: state.refresh };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: ({ label }: { label: string }) =>
    label === "upsert"
      ? (input: unknown) => {
          state.calls(input);
          return state.upsert?.(input) ?? Promise.resolve({ _tag: "Failure" });
        }
      : () => Promise.resolve({ _tag: "Failure" }),
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  usePreparedConnection: () => Option.some(state.listeners),
  readPreparedConnection: () => state.listeners,
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("./settingsLayout", async (original) => ({
  ...(await original<typeof import("./settingsLayout")>()),
  SettingsRow: ({ title, control, children }: Record<string, ReactNode>) => (
    <div>
      {title}
      {control}
      {children}
    </div>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
import { memoryEnvironment } from "../../state/memory";
import { MemoryDetails } from "./MemorySettings";
import { validateMemorySettingsSearch } from "./MemorySettings.logic";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const decodeItem = Schema.decodeUnknownSync(MemoryItem);
const decodeRevision = Schema.decodeUnknownSync(MemoryRevision);
const memoryItem = (n: number, text: string) =>
  decodeItem({
    memorySpaceId: id(1),
    memoryId: id(2),
    scope: { kind: "user" },
    pendingSync: false,
    status: "active",
    revision: decodeRevision({
      memorySpaceId: id(1),
      memoryId: id(2),
      revisionId: id(n),
      operationId: id(10 + n),
      parents: [],
      scope: { kind: "user" },
      payloadRef: id(n),
      assertionKind: "fact",
      provenance: { environmentId: "remote-owner" },
      createdAtUtc: "2026-09-01T00:00:00.000Z",
    }),
    payload: {
      text,
      evidence: [{ origin: "user", messageIds: [] }],
      derivedFromMemoryRevisions: [],
    },
    localAvailability: { exposure: "visible", reasons: [], deferred: [], cleanupPending: false },
  });
const original = memoryItem(5, "Synthetic original");
const saved = memoryItem(6, "Synthetic original, saved");
const FORGOTTEN_LINE =
  "Closed because this memory is no longer available. A related memory may have been forgotten.";
const HIDDEN_LINE = "Memory text hidden after a minute.";
const CHANGED_LINE =
  "Edit closed because this memory is no longer the version you started from. Your unsaved text was not kept.";
const UNAVAILABLE_LINE =
  "Memory details are unavailable right now. Visible details have been cleared.";

/** Resets the fixture to a visible memory 2 in a ready space, with editing allowed. */
function setup() {
  state.version = 0;
  state.listeners.clear();
  state.exposure = readyMemoryExposure(id(1));
  state.write = true;
  state.queries.clear();
  state.queries.set("read", Option.some(original));
  state.upsert = null;
  for (const mock of [state.calls, state.refresh, state.navigate, state.onForgotten])
    mock.mockReset();
  const registry = AtomRegistry.make();
  const get = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation((atom) => {
    const label = (atom as unknown as { label?: string }).label;
    return label ? (fixtureValue(label) as never) : get(atom);
  });
  return registry;
}
const details = (onForgotten: (message: string) => void) => (
  <MemoryDetails
    target={validateMemorySettingsSearch({
      environmentId: "remote-owner",
      memorySpaceId: id(1),
      memoryId: id(2),
    })}
    environmentId={EnvironmentId.make("remote-owner")}
    memorySpaceId={MemorySpaceId.make(id(1))}
    onForgotten={onForgotten}
    memoryEnabled
  />
);
function renderDetails(registry: AtomRegistry.AtomRegistry, ui = details(state.onForgotten)) {
  return render(
    <RegistryContext value={registry}>{ui}</RegistryContext>,
    // useNavigate is mocked to observe where the details send the person.
    { router: false },
  );
}
async function update(change: () => void) {
  await act(() => {
    change();
    state.version += 1;
    for (const listener of state.listeners) listener();
  });
}
const editDraft = () =>
  memoryEnvironment.draftAtom({
    environmentId: EnvironmentId.make("remote-owner"),
    input: { memorySpaceId: MemorySpaceId.make(id(1)) },
    draftId: `editor:${id(2)}`,
  });
/** The one-minute expiry: the body read ends with no body-free change. */
const expire = () => {
  state.queries.set("read", Option.none());
  state.queries.set("history", Option.none());
};
/** A body-free change: the read empties and, unless the shared reread keeps it, the draft purges. */
function signal(
  registry: AtomRegistry.AtomRegistry,
  kind: "upsert" | "forget" | "invalidate",
  memoryId = id(2),
  { purge = true } = {},
) {
  state.exposure = withMemorySignal(state.exposure, id(1), kind, memoryId);
  if (purge) registry.set(editDraft(), null);
  expire();
}
const memoryText = (screen: Screen) =>
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Memory text"]');
async function click(screen: Screen, label: string) {
  const button = [...screen.container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  expect(button, label).toBeDefined();
  await act(() => button!.click());
}
async function type(screen: Screen, value: string) {
  const textarea = memoryText(screen)!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function save(screen: Screen) {
  await act(() =>
    memoryText(screen)!
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

it("keeps an edited draft through the one-minute expiry, claims no forget, and saves against the starting version", async () => {
  const registry = setup();
  state.upsert = async () => ({ _tag: "Success", value: { outcome: "accepted" } });
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Synthetic original, edited");
  await update(expire);
  expect(memoryText(screen)?.value).toBe("Synthetic original, edited");
  expect(screen.container.textContent).toContain(HIDDEN_LINE);
  expect(state.onForgotten).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  // Once the text is hidden, any change keeps the edit, even typing the original back.
  await type(screen, "Synthetic original");
  await update(() => {});
  expect(memoryText(screen)?.value).toBe("Synthetic original");
  await type(screen, "Synthetic original, edited");
  await save(screen);
  expect(state.calls).toHaveBeenLastCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        memoryId: id(2),
        expectedHeads: [id(5)],
        scope: { kind: "user" },
        assertionKind: "fact",
        payload: expect.objectContaining({ text: "Synthetic original, edited" }),
      }),
    }),
  );
  expect(memoryText(screen)).toBeNull();
  expect(state.navigate).not.toHaveBeenCalled();
});

it.each(["untouched", "typed back to the original"])(
  "hides an editor left %s at the one-minute expiry and shows the text again on request",
  async (how) => {
    const registry = setup();
    await using screen = await renderDetails(registry);
    await click(screen, "Edit");
    if (how !== "untouched") {
      await type(screen, "Synthetic original, edited");
      await type(screen, "Synthetic original");
    }
    await update(expire);
    expect(memoryText(screen)).toBeNull();
    expect(registry.get(editDraft())).toBeNull();
    expect(screen.container.textContent).not.toContain("Synthetic original");
    expect(screen.container.textContent).toContain(HIDDEN_LINE);
    expect(state.onForgotten).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
    await click(screen, "Show again");
    expect(state.refresh).toHaveBeenCalled();
    // A read this view asked for shows nothing new while it is pending.
    expect(screen.container.textContent).not.toContain(HIDDEN_LINE);
    expect(screen.container.textContent).not.toContain(UNAVAILABLE_LINE);
    await update(() => state.queries.set("read", Option.some(original)));
    expect(screen.container.textContent).toContain("Synthetic original");
    expect(memoryText(screen)).toBeNull();
  },
);

it.each([true, false])(
  "closes the editor after its own accepted save with no wrong line (change signal before the reply: %s)",
  async (signalFirst) => {
    const registry = setup();
    let reply!: (value: unknown) => void;
    state.upsert = () => new Promise((resolve) => (reply = resolve));
    await using screen = await renderDetails(registry);
    await click(screen, "Edit");
    await type(screen, "Synthetic original, saved");
    await save(screen);
    const ownChangeSignal = async () => {
      await update(() => signal(registry, "upsert"));
      expect(screen.container.textContent).not.toContain(CHANGED_LINE);
      expect(state.onForgotten).not.toHaveBeenCalled();
    };
    if (signalFirst) await ownChangeSignal();
    await act(() => reply({ _tag: "Success", value: { outcome: "accepted" } }));
    if (!signalFirst) await ownChangeSignal();
    expect(memoryText(screen)).toBeNull();
    await update(() => state.queries.set("read", Option.some(saved)));
    expect(screen.container.textContent).toContain("Synthetic original, saved");
    expect(memoryText(screen)).toBeNull();
    expect(screen.container.textContent).not.toContain(CHANGED_LINE);
    expect(screen.container.textContent).not.toContain("Editing unavailable");
    expect(state.onForgotten).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  },
);

it("closes an edit changed by another save with the version line and stays on the memory", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Synthetic original, edited");
  await update(() => signal(registry, "upsert"));
  expect(memoryText(screen)).toBeNull();
  expect(screen.container.textContent).toContain(CHANGED_LINE);
  expect(state.onForgotten).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  await update(() => state.queries.set("read", Option.some(saved)));
  expect(screen.container.textContent).toContain("Synthetic original, saved");
});

it("keeps read-only details open when another save changes the memory", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await update(() => signal(registry, "upsert"));
  expect(state.onForgotten).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  await update(() => state.queries.set("read", Option.some(saved)));
  expect(screen.container.textContent).toContain("Synthetic original, saved");
  expect(screen.container.textContent).not.toContain(CHANGED_LINE);
});

it("closes the editor on a disconnect with a neutral line that never claims a forget", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Synthetic original, edited");
  await update(() => {
    state.exposure = emptyMemoryExposure();
    registry.set(editDraft(), null);
    expire();
  });
  expect(memoryText(screen)).toBeNull();
  expect(screen.container.textContent).toContain(UNAVAILABLE_LINE);
  expect(state.onForgotten).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});

it.each([
  { forgotten: "this memory", memoryId: id(2) },
  { forgotten: "a memory it was derived from", memoryId: id(9) },
])(
  "closes the editor and leaves with the forgotten line when $forgotten is forgotten",
  async ({ memoryId }) => {
    const registry = setup();
    await using screen = await renderDetails(registry);
    await click(screen, "Edit");
    await type(screen, "Synthetic original, edited");
    await update(() => signal(registry, "forget", memoryId));
    expect(memoryText(screen)).toBeNull();
    expect(screen.container.textContent).not.toContain("Synthetic original");
    expect(state.onForgotten).toHaveBeenCalledWith(FORGOTTEN_LINE);
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/settings/memory", hash: "" }),
    );
  },
);

it("leaves once on a forget while its parent re-renders with a new callback", async () => {
  const registry = setup();
  // Like the memory list, whose callback captures its refreshed page: a new callback each update.
  function List() {
    const [notices, setNotices] = useState(0);
    return (
      <>
        <p>{notices} notices</p>
        {details((message) => {
          state.onForgotten(message);
          // Capped so a details view that re-fires fails on the count instead of looping forever.
          setNotices(Math.min(notices + 1, 3));
        })}
      </>
    );
  }
  await using screen = await renderDetails(registry, <List />);
  await update(() => signal(registry, "forget"));
  expect(screen.container.textContent).toContain("1 notices");
  expect(state.onForgotten).toHaveBeenCalledTimes(1);
  expect(state.navigate).toHaveBeenCalledTimes(1);
});

const heldForScan = decodeItem({
  memorySpaceId: id(1),
  memoryId: id(2),
  status: "blocked",
  scope: { kind: "user" },
  failureCode: "scanner_pending",
  pendingSync: false,
  localAvailability: {
    exposure: "held",
    reasons: ["scanner_pending"],
    deferred: [],
    cleanupPending: false,
  },
});

it("keeps an edited draft open through its own save's hub confirmation and the scanner's release", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Synthetic original, edited");
  // The shared reread found the same revision held for this device's re-scan: the draft stays.
  await update(() => signal(registry, "upsert", id(2), { purge: false }));
  expect(memoryText(screen)?.value).toBe("Synthetic original, edited");
  await update(() => state.queries.set("read", Option.some(heldForScan)));
  expect(memoryText(screen)?.value).toBe("Synthetic original, edited");
  await update(() => {
    signal(registry, "invalidate", id(2), { purge: false });
    state.queries.set("read", Option.some(original));
  });
  expect(memoryText(screen)?.value).toBe("Synthetic original, edited");
  expect(screen.container.textContent).not.toContain(CHANGED_LINE);
  expect(state.onForgotten).not.toHaveBeenCalled();
});

it("closes an untouched editor without the version line when the shared reread discards its draft", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await update(() => {
    signal(registry, "upsert");
    state.queries.set("read", Option.some(heldForScan));
  });
  expect(memoryText(screen)).toBeNull();
  expect(screen.container.textContent).not.toContain("Synthetic original");
  // Nothing typed was lost, so no line claims it.
  expect(screen.container.textContent).not.toContain(CHANGED_LINE);
});

it("hides and closes an edited draft kept past the minute when a privacy hold arrives", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Synthetic original, edited");
  await update(expire);
  expect(memoryText(screen)?.value).toBe("Synthetic original, edited");
  await update(() => signal(registry, "invalidate"));
  expect(memoryText(screen)).toBeNull();
  expect(screen.container.textContent).not.toContain("Synthetic original, edited");
  expect(screen.container.textContent).toContain(CHANGED_LINE);
});

it("offers Save only once the draft differs from the memory", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  const saveButton = () =>
    [...screen.container.querySelectorAll("button")].find((b) => b.textContent === "Save memory");
  expect(saveButton()?.disabled).toBe(true);
  await type(screen, "Synthetic original, edited");
  expect(saveButton()?.disabled).toBe(false);
});
it("masks an untouched editor while the reread after a change is pending", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await update(() => signal(registry, "upsert", id(2), { purge: false }));
  expect(memoryText(screen)?.value).toBe("");
  expect(memoryText(screen)?.disabled).toBe(true);
  expect(screen.container.textContent).not.toContain("Synthetic original");
  // The reread shows the same revision: the edit is back.
  await update(() => state.queries.set("read", Option.some(original)));
  expect(memoryText(screen)?.value).toBe("Synthetic original");
  expect(memoryText(screen)?.disabled).toBe(false);
});

it("keeps an edited draft visible and editable while the reread after a change is pending", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Synthetic original, edited");
  await update(() => signal(registry, "upsert", id(2), { purge: false }));
  expect(memoryText(screen)?.value).toBe("Synthetic original, edited");
  expect(memoryText(screen)?.disabled).toBe(false);
});
