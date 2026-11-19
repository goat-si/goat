import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  MemoryItem,
  MemoryRpcError,
  MemoryRevision,
  MemorySpaceId,
} from "@goat/contracts";
import { emptyMemoryExposure } from "@goat/client-runtime/state/memory";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render, type Screen } from "../../../test/render";
import { readyMemoryExposure, withMemorySignal } from "../../test/memoryExposureFixture";

const state = vi.hoisted(() => ({
  version: 0,
  listeners: new Set<() => void>(),
  exposure: null as unknown as import("@goat/client-runtime/state/memory").MemoryExposure,
  write: true,
  readPending: false,
  revert: null as unknown,
  queries: new Map<string, unknown>(),
  upsert: null as ((input: unknown) => Promise<unknown>) | null,
  calls: vi.fn(),
  move: vi.fn(),
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
  if (label === "read") return AsyncResult.success(state.queries.get("read") ?? Option.none());
  if (label === "readReply")
    return state.readPending ? null : (state.queries.get("read") ?? Option.none());
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
      read: Object.assign(() => ({ label: "read" }), { reply: () => ({ label: "readReply" }) }),
      revertResolution: command("revert"),
      resetReportAttempts: command("resetReportAttempts"),
      history: () => ({ label: "history" }),
      readSource: () => ({ label: "readSource" }),
      upsert: command("upsert"),
      forget: command("forget"),
      move: command("move"),
      projectBindingGet: command("projectBindingGet"),
      projectBindingUpdate: command("projectBindingUpdate"),
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
  useAtomCommand: ({ label }: { label: string }) => {
    if (label === "move") return state.move;
    return label === "upsert"
      ? (input: unknown) => {
          state.calls(input);
          return state.upsert?.(input) ?? Promise.resolve({ _tag: "Failure" });
        }
      : () => Promise.resolve(label === "revert" ? state.revert : { _tag: "Failure" });
  },
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  useProjects: () => [],
  useThreadShells: () => [],
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
import { MemoryOriginPicker } from "./MemoryErgonomics";
import { measureMemoryListRow, memoryListPageIdentity, MemoryDetails } from "./MemorySettings";
import { validateMemorySettingsSearch } from "./MemorySettings.logic";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("shows the conversation picker's unfiltered value before opening the menu", async () => {
  await using screen = await render(
    <MemoryOriginPicker environmentId={EnvironmentId.make("remote-owner")} onChange={vi.fn()} />,
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Saved from conversation" }))
    .toHaveTextContent("Any conversation");
});
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
  state.readPending = false;
  state.revert = null;
  state.queries.clear();
  state.queries.set("read", Option.some(original));
  state.upsert = null;
  for (const mock of [state.calls, state.move, state.refresh, state.navigate, state.onForgotten])
    mock.mockReset();
  const registry = AtomRegistry.make();
  const get = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation((atom) => {
    const label = (atom as unknown as { label?: string }).label;
    return label ? (fixtureValue(label) as never) : get(atom);
  });
  return registry;
}
const details = (onForgotten: (message: string) => void, scopeMoves = false) => (
  <MemoryDetails
    target={validateMemorySettingsSearch({
      environmentId: "remote-owner",
      memorySpaceId: id(1),
      memoryId: id(2),
    })}
    environmentId={EnvironmentId.make("remote-owner")}
    memorySpaceId={MemorySpaceId.make(id(1))}
    onForgotten={onForgotten}
    scopeMoves={scopeMoves}
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
const saveButton = (screen: Screen) =>
  [...screen.container.querySelectorAll("button")].find((b) => b.textContent === "Save memory");
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

it.each(["accepted", "expired"])("reports a details move when the body is %s", async (event) => {
  const registry = setup();
  const scope = { kind: "thread", thread: { environmentId: "remote-owner", threadId: "source" } };
  if (original.status !== "active") throw new Error("Expected an active memory");
  const before = decodeItem({ ...original, scope, revision: { ...original.revision, scope } });
  state.queries.set("read", Option.some(before));
  const receipt = Promise.withResolvers<unknown>();
  state.move.mockReturnValue(receipt.promise);
  await using screen = await renderDetails(registry, details(state.onForgotten, true));
  await click(screen, "Move to…");
  await screen.getByRole("combobox", { name: "Memory scope" }).click();
  await screen.getByRole("option", { name: "All projects" }).click();
  if (event === "expired") {
    await update(expire);
    await expect.element(screen.getByText("Show the memory again to move it.")).toBeVisible();
    expect(state.move).not.toHaveBeenCalled();
    return;
  }
  await screen.getByRole("button", { name: "Move memory", exact: true }).click();
  expect(state.move).toHaveBeenCalledOnce();
  await update(() => signal(registry, "invalidate"));
  await act(() => receipt.resolve({ _tag: "Success", value: { outcome: "accepted" } }));
  await expect.element(screen.getByText("Memory moved.")).toBeVisible();
  await update(() => state.queries.set("read", Option.some(original)));
  await expect.element(screen.getByText("Scope: User")).toBeVisible();
});

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
    state.refresh.mockImplementation(() => {
      state.readPending = true;
    });
    await click(screen, "Show again");
    expect(state.refresh).toHaveBeenCalled();
    // A read this view asked for shows nothing new while it is pending.
    expect(screen.container.textContent).not.toContain(HIDDEN_LINE);
    expect(screen.container.textContent).not.toContain(UNAVAILABLE_LINE);
    await update(() => {
      state.readPending = false;
      state.queries.set("read", Option.some(original));
    });
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
  expect(memoryText(screen)?.value).toBe("");
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
  expect(saveButton(screen)?.disabled).toBe(true);
  await type(screen, "Synthetic original, edited");
  expect(saveButton(screen)?.disabled).toBe(false);
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

it("masks an edited copy while a pending forget is read, then closes the edit when the hold is confirmed", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Synthetic original!");
  await update(() => {
    state.readPending = true;
    signal(registry, "invalidate", id(2), { purge: false });
  });
  expect(memoryText(screen)?.value).toBe("");
  expect(memoryText(screen)?.disabled).toBe(true);
  expect(saveButton(screen)?.disabled).toBe(true);
  expect(screen.container.textContent).not.toContain("Synthetic original");
  await save(screen);
  expect(state.calls).not.toHaveBeenCalled();

  await update(() => {
    state.readPending = false;
    registry.set(editDraft(), null);
    state.queries.set(
      "read",
      Option.some(
        decodeItem({
          ...heldForScan,
          failureCode: "forget_pending",
          localAvailability: { ...heldForScan.localAvailability, reasons: ["forget_pending"] },
        }),
      ),
    );
  });
  expect(memoryText(screen)).toBeNull();
  expect(screen.container.textContent).not.toContain("Synthetic original");
  expect(screen.container.textContent).toContain(CHANGED_LINE);
});

it("restores edited text and Save when the reread confirms the same visible revision", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Synthetic original!");
  await update(() => signal(registry, "upsert", id(2), { purge: false }));
  expect(memoryText(screen)?.value).toBe("");
  await update(() => state.queries.set("read", Option.some(original)));
  expect(memoryText(screen)?.value).toBe("Synthetic original!");
  expect(saveButton(screen)?.disabled).toBe(false);
});
it("chosen behaviour: when the reread after a change never answers, the edited draft closes with the version line", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Synthetic original, edited");
  await update(() => signal(registry, "upsert", id(2), { purge: false }));
  expect(memoryText(screen)?.value).toBe("");
  // The shared draft discards itself when the reread's 60-second request ends unanswered.
  await update(() => registry.set(editDraft(), null));
  expect(memoryText(screen)).toBeNull();
  expect(screen.container.textContent).toContain(CHANGED_LINE);
  expect(state.onForgotten).not.toHaveBeenCalled();
});
it("a second click on Edit keeps the typing, Save and the edit past the minute", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Synthetic original, edited");
  const button = (label: string) =>
    [...screen.container.querySelectorAll("button")].find((b) => b.textContent === label);
  await act(() => button("Edit")?.click());
  expect(memoryText(screen)?.value).toBe("Synthetic original, edited");
  expect(button("Save memory")?.disabled).toBe(false);
  await update(expire);
  expect(memoryText(screen)?.value).toBe("Synthetic original, edited");
  expect(screen.container.textContent).toContain(HIDDEN_LINE);
});
it("Edit is unavailable while an edit is open, and available again after Cancel", async () => {
  const registry = setup();
  await using screen = await renderDetails(registry);
  const editButton = () =>
    [...screen.container.querySelectorAll("button")].find((b) => b.textContent === "Edit");
  expect(editButton()?.disabled).toBe(false);
  await click(screen, "Edit");
  expect(editButton()?.disabled).toBe(true);
  await click(screen, "Cancel");
  expect(editButton()?.disabled).toBe(false);
});

/** A detected secret from another device's scan: a hold that is not this device's own re-scan. */
const heldForSecret = decodeItem({
  memorySpaceId: id(1),
  memoryId: id(2),
  status: "blocked",
  scope: { kind: "user" },
  failureCode: "secret_detected",
  pendingSync: false,
  localAvailability: {
    exposure: "held",
    reasons: ["secret_detected"],
    deferred: [],
    cleanupPending: false,
  },
});

it.each([
  { outcome: "accepted", line: false },
  { outcome: "rejected", line: true },
])(
  "a hold during an in-flight save hides the typed text immediately; the reply ($outcome) closes the editor",
  async ({ outcome, line }) => {
    const registry = setup();
    let reply!: (value: unknown) => void;
    state.upsert = () => new Promise((resolve) => (reply = resolve));
    await using screen = await renderDetails(registry);
    await click(screen, "Edit");
    await type(screen, "Synthetic original, edited");
    await save(screen);
    await update(() => signal(registry, "invalidate", id(2), { purge: false }));
    expect(memoryText(screen)?.value).toBe("");
    expect(memoryText(screen)?.disabled).toBe(true);
    // The reread shows the hold: the shared draft discards the typing; the save keeps its form.
    await update(() => {
      registry.set(editDraft(), null);
      state.queries.set("read", Option.some(heldForSecret));
    });
    expect(memoryText(screen)?.value).toBe("");
    expect(memoryText(screen)?.disabled).toBe(true);
    expect(screen.container.textContent).not.toContain("Synthetic original");
    await act(() => reply({ _tag: "Success", value: { outcome } }));
    expect(memoryText(screen)).toBeNull();
    expect(screen.container.textContent).not.toContain("Synthetic original");
    if (line) expect(screen.container.textContent).toContain(CHANGED_LINE);
    else expect(screen.container.textContent).not.toContain(CHANGED_LINE);
    expect(state.onForgotten).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  },
);

it("a hold after a refused save discards the draft and closes the editor with the version line", async () => {
  const registry = setup();
  state.upsert = async () => ({ _tag: "Success", value: { outcome: "rejected" } });
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Synthetic original, edited");
  await save(screen);
  expect(memoryText(screen)?.value).toBe("Synthetic original, edited");
  expect(screen.container.textContent).toContain("Memory update failed.");
  await update(() => {
    signal(registry, "invalidate");
    state.queries.set("read", Option.some(heldForSecret));
  });
  expect(memoryText(screen)).toBeNull();
  expect(screen.container.textContent).not.toContain("Synthetic original");
  expect(screen.container.textContent).toContain(CHANGED_LINE);
  expect(state.onForgotten).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});

it.each(["unchanged", "held", "empty"] as const)(
  "keeps an untouched edit pending until the refresh after revert settles as %s",
  async (settlement) => {
    const registry = setup();
    if (original.status !== "active" || saved.status !== "active")
      throw new Error("Active fixtures required");
    const resolution = {
      resolutionId: id(8),
      memoryId: id(2),
      memorySpaceId: id(1),
      resultRevisionId: original.revision.revisionId,
      inputRevisionIds: [saved.revision.revisionId],
      requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
      effectiveProvider: "codex",
      effectiveModel: "synthetic",
      resolvingEnvironmentId: "remote-owner",
      appliedAtUtc: "2026-09-01T00:00:00.000Z",
      revertDeadlineUtc: "2099-10-01T00:00:00.000Z",
    };
    state.queries.set(
      "history",
      Option.some({
        revisions: [{ revision: saved.revision, payload: saved.payload }],
        resolutions: [{ resolution, payload: null }],
        nextCursor: null,
        reports: [],
        revertResults: [],
      }),
    );
    state.revert = {
      _tag: "Success",
      value: { operationId: id(9), memoryId: id(2), resolutionId: id(8), status: "pending" },
    };
    state.refresh.mockImplementation(() => {
      state.readPending = true;
      expire();
      state.version += 1;
      for (const listener of state.listeners) listener();
    });
    await using screen = await renderDetails(registry);
    await click(screen, "Edit");
    const editor = memoryText(screen);
    await click(screen, "Open Resolution");
    await act(() =>
      screen.container.querySelector<HTMLInputElement>('input[type="radio"]')!.click(),
    );
    await click(screen, "Revert resolution");

    expect(memoryText(screen)).toBe(editor);
    expect(memoryText(screen)?.value).toBe("");
    expect(screen.container.textContent).not.toContain(HIDDEN_LINE);
    expect(state.onForgotten).not.toHaveBeenCalled();

    await update(() => {
      state.readPending = false;
      state.queries.set(
        "read",
        settlement === "empty"
          ? Option.none()
          : Option.some(settlement === "held" ? heldForSecret : original),
      );
    });
    if (settlement !== "unchanged") {
      expect(memoryText(screen)).toBeNull();
      expect(screen.container.textContent).not.toContain("Synthetic original");
      expect(screen.container.textContent).not.toContain(HIDDEN_LINE);
      return;
    }
    expect(memoryText(screen)).toBe(editor);
    expect(memoryText(screen)?.value).toBe("Synthetic original");
    await update(() => state.queries.set("read", Option.some(saved)));
    expect(memoryText(screen)).toBeNull();
    expect(screen.container.textContent).toContain("Synthetic original, saved");
  },
);

it.each(["rpc", "receipt"])("reviews a fresh revision after a stale save (%s)", async (kind) => {
  const registry = setup();
  state.upsert = async () =>
    kind === "rpc"
      ? { _tag: "Failure", cause: Cause.fail(new MemoryRpcError({ code: "revision_changed" })) }
      : { _tag: "Success", value: { outcome: "rejected", failureCode: "revision_changed" } };
  await using screen = await renderDetails(registry);
  await click(screen, "Edit");
  await type(screen, "Stale draft");
  await save(screen);
  expect(screen.container.textContent).toContain("This memory changed before your save.");
  await save(screen);
  expect(state.calls).toHaveBeenCalledTimes(1);

  state.refresh.mockImplementation(() => state.queries.set("read", Option.some(saved)));
  await click(screen, "Review latest memory");
  expect(screen.container.textContent).toContain("Synthetic original, saved");
  expect(screen.container.textContent).toContain(`Current revision: ${id(6)}`);
  expect(memoryText(screen)).toBeNull();
  await click(screen, "Edit");
  await type(screen, "Edit after review");
  state.upsert = async () => ({
    _tag: "Success",
    value: { outcome: "accepted", pendingSync: false },
  });
  await save(screen);

  expect(state.calls).toHaveBeenCalledTimes(2);
  expect(state.calls.mock.calls[1]?.[0].input.expectedHeads).toEqual([id(6)]);
  expect(state.calls.mock.calls[1]?.[0].input.operationId).not.toBe(
    state.calls.mock.calls[0]?.[0].input.operationId,
  );
});
it.each([
  ["conflicted", false, "The save conflicted with another revision."],
  ["deleted", false, "This memory was deleted before the save applied."],
  ["accepted", true, "Save submitted for sync."],
] as const)(
  "reports the %s save receipt with pending sync %s",
  async (outcome, pendingSync, message) => {
    const registry = setup();
    state.upsert = async () => ({ _tag: "Success", value: { outcome, pendingSync } });
    await using screen = await renderDetails(registry);
    await click(screen, "Edit");
    await type(screen, "Typed update");
    await save(screen);
    expect(screen.container.textContent).toContain(message);
    expect(screen.container.textContent).not.toContain("Retry memory request");
    expect(memoryText(screen) !== null).toBe(!pendingSync);
  },
);

it("keeps only row ids and sizes in a measured list page", () => {
  const items = [original];
  const page = memoryListPageIdentity(items);
  const layout = measureMemoryListRow(null, page, original.memoryId, 100);
  expect(layout).toEqual({
    page: { rowIds: [original.memoryId] },
    height: 100,
    sizes: new Map([[original.memoryId, 100]]),
  });
  expect(memoryListPageIdentity(items)).toBe(page);
  const fresh = memoryListPageIdentity([saved]);
  const remeasured = measureMemoryListRow(layout, fresh, saved.memoryId, 72);
  expect(remeasured).toEqual({
    page: { rowIds: [saved.memoryId] },
    height: 72,
    sizes: new Map([[saved.memoryId, 72]]),
  });
  expect(fresh).not.toBe(page);
});

it("hides newer historical, judgment and source text as soon as the current body expires", async () => {
  const registry = setup();
  if (original.status !== "active" || saved.status !== "active")
    throw new Error("Active fixtures required");
  state.queries.set(
    "history",
    Option.some({
      revisions: [
        {
          revision: saved.revision,
          payload: {
            ...saved.payload,
            text: "Retained version text",
            evidence: [
              {
                origin: "thread",
                sourceThread: { environmentId: "remote-owner", threadId: "synthetic-thread" },
                messageIds: ["synthetic-message"],
              },
            ],
          },
        },
      ],
      resolutions: [
        {
          resolution: {
            resolutionId: id(8),
            memoryId: id(2),
            memorySpaceId: id(1),
            resultRevisionId: saved.revision.revisionId,
            inputRevisionIds: [original.revision.revisionId],
            requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
            effectiveProvider: "codex",
            effectiveModel: "synthetic",
            resolvingEnvironmentId: "remote-owner",
            appliedAtUtc: "2026-09-01T00:00:00.000Z",
            revertDeadlineUtc: "2026-10-01T00:00:00.000Z",
          },
          payload: { judgment: "Retained judgment text" },
        },
      ],
      nextCursor: null,
      reports: [],
      revertResults: [],
    }),
  );
  state.queries.set(
    "readSource",
    Option.some({
      messages: [{ messageId: "synthetic-message", text: "Later original source text" }],
      nextCursor: null,
    }),
  );
  await using screen = await renderDetails(registry);
  await click(screen, "Open Version 1");
  await click(screen, "Open Resolution");
  await click(screen, "Read original");
  const bodyText = [
    "Synthetic original",
    "Retained version text",
    "Retained judgment text",
    "Later original source text",
  ];
  for (const value of bodyText) expect(screen.container.textContent).toContain(value);

  await update(() => state.queries.set("read", Option.none()));
  expect(screen.container.textContent).toContain(HIDDEN_LINE);
  for (const value of bodyText) expect(screen.container.textContent).not.toContain(value);

  state.refresh.mockImplementation(() => {
    state.readPending = true;
    state.queries.delete("history");
    state.queries.delete("readSource");
  });
  await click(screen, "Show again");
  for (const value of bodyText) expect(screen.container.textContent).not.toContain(value);
  await update(() => {
    state.readPending = false;
    state.queries.set("read", Option.some(saved));
  });
  expect(screen.container.textContent).toContain("Synthetic original, saved");
  for (const value of bodyText.slice(1)) expect(screen.container.textContent).not.toContain(value);
});

it.each(["lost reply", "hub_unavailable"] as const)(
  "retries an unconfirmed save using the original operation and payload: %s",
  async (failure) => {
    const registry = setup();
    state.upsert = async () => ({
      _tag: "Failure",
      cause: Cause.fail(
        failure === "hub_unavailable"
          ? new MemoryRpcError({ code: failure })
          : new Error("Synthetic lost reply"),
      ),
    });
    await using screen = await renderDetails(registry);
    await click(screen, "Edit");
    await type(screen, "Typed once");
    const catchUpOtherOrigin = () =>
      update(() => {
        state.exposure = withMemorySignal(state.exposure, id(1), "invalidate", id(9));
      });
    await catchUpOtherOrigin();
    expect(memoryText(screen)?.value).toBe("Typed once");
    await save(screen);
    expect(screen.container.textContent).toContain("The save could not be confirmed.");
    expect(memoryText(screen)?.disabled).toBe(true);
    state.upsert = async () => ({
      _tag: "Success",
      value: { outcome: "accepted", pendingSync: false },
    });
    await catchUpOtherOrigin();
    await click(screen, "Retry memory request");
    expect(state.calls).toHaveBeenCalledTimes(2);
    expect(state.calls.mock.calls[1]?.[0]).toEqual(state.calls.mock.calls[0]?.[0]);
    expect(memoryText(screen)).toBeNull();
  },
);
