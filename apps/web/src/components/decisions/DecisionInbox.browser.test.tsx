import { RegistryContext } from "@effect/atom-react";
import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import type { AtomCommandResult } from "@goat/client-runtime/state/runtime";
import { EnvironmentId, RuntimeRequestId, ThreadId, type ScopedThreadRef } from "@goat/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Snapshot = {
  items: readonly DecisionItem[];
  authoritativeRefs: readonly ScopedThreadRef[];
  loadingRefs: readonly ScopedThreadRef[];
  errors: readonly { ref: ScopedThreadRef; message: string }[];
  isLoading: boolean;
};
type Receipt = AtomCommandResult<void, Error>;
type Run = (...args: unknown[]) => Promise<Receipt>;
const state = vi.hoisted<{
  registry: AtomRegistry.AtomRegistry | null;
  snapshot: Atom.Writable<Snapshot> | null;
  grants: Atom.Writable<ReadonlySet<EnvironmentId>> | null;
  approval: ReturnType<typeof vi.fn<Run>>;
  userInput: ReturnType<typeof vi.fn<Run>>;
}>(() => ({
  registry: null,
  snapshot: null,
  grants: null,
  approval: vi.fn<Run>(),
  userInput: vi.fn<Run>(),
}));
vi.mock("../../state/decisionInbox", async () => {
  const { Atom } = await import("effect/reactivity");
  state.snapshot = Atom.make<Snapshot>({
    items: [],
    authoritativeRefs: [],
    loadingRefs: [],
    errors: [],
    isLoading: false,
  }).pipe(Atom.keepAlive);
  return {
    decisionInbox: { itemsAtom: state.snapshot, summaryAtom: Atom.make({ count: 2, refs: [] }) },
  };
});
vi.mock("../../state/threads", () => ({
  threadEnvironment: { respondToApproval: "approval", respondToUserInput: "userInput" },
}));
// Browser mocks snapshot their exports, so forward to the registry each test creates.
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value = Reflect.get(state.registry!, key);
        return typeof value === "function" ? value.bind(state.registry) : value;
      },
    },
  ),
}));
vi.mock("../../state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const { useAtomValue } = await import("@effect/atom-react");
  state.grants = Atom.make<ReadonlySet<EnvironmentId>>(new Set<EnvironmentId>()).pipe(
    Atom.keepAlive,
  );
  return {
    useEnvironmentScope: (id: EnvironmentId) => useAtomValue(state.grants!).has(id),
    readEnvironmentScope: (id: EnvironmentId) => state.registry!.get(state.grants!).has(id),
  };
});
vi.mock("../ChatMarkdown", () => ({
  default: (props: { readonly text: string }) => <p>{props.text}</p>,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "approval" ? state.approval : state.userInput),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: ScopedThreadRef) => ({ title: `Thread ${ref.threadId}` }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: (id: EnvironmentId) => ({ label: `Environment ${id}` }),
}));

import { DecisionInbox } from "./DecisionInbox";
import { TooltipProvider } from "../ui/tooltip";

const secondary = EnvironmentId.make("secondary");
const primary = EnvironmentId.make("primary");
function approval(
  id: string,
  environmentId = secondary,
  thread = "a",
  createdAt = "2026-10-01T00:00:00.000Z",
): Extract<DecisionItem, { kind: "approval" }> {
  const ref = { environmentId, threadId: ThreadId.make(thread) };
  return {
    id: JSON.stringify([environmentId, thread, id]),
    ref,
    kind: "approval",
    createdAt,
    request: {
      requestId: RuntimeRequestId.make(id),
      requestKind: "command",
      createdAt,
      responseCapability: "live",
      detail: `Run command ${id}`,
      options: [
        { decision: "accept", label: "Approve" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow session" },
      ],
    },
  };
}
const a = approval("a");
const b = approval("b", primary, "b", "2026-10-02T00:00:00.000Z");
function question(
  responseCapability: "live" | "message" | "not_resumable",
): Extract<DecisionItem, { kind: "user_input" }> {
  return {
    ...a,
    kind: "user_input",
    request: {
      requestId: a.request.requestId,
      createdAt: a.createdAt,
      responseCapability,
      dismissible: false,
      questions: [
        {
          id: "approach",
          header: "Approach",
          question: "Which approach?",
          multiSelect: false,
          allowCustomAnswer: false,
          options: [
            { label: "Incremental", value: "stable-id", description: "One module at a time" },
          ],
        },
      ],
    },
  };
}
function makeRouter() {
  const rootRoute = createRootRoute({ component: Outlet });
  const decisions = createRoute({
    getParentRoute: () => rootRoute,
    path: "/decisions",
    component: DecisionInbox,
  });
  const thread = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$environmentId/$threadId",
    component: () => <p>Opened thread</p>,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([decisions, thread]),
    history: createMemoryHistory({ initialEntries: ["/decisions"] }),
    defaultPendingMinMs: 0,
  });
}
let root: Root;
let router: ReturnType<typeof makeRouter>;
let container: HTMLDivElement;
function write(items: readonly DecisionItem[], diagnostics: Partial<Omit<Snapshot, "items">> = {}) {
  // Every fixture thread is live unless the test marks it loading or failed, so a
  // request missing from items counts as answered.
  const unresolved = [
    ...(diagnostics.loadingRefs ?? []),
    ...(diagnostics.errors ?? []).map(({ ref }) => ref),
  ];
  state.registry!.set(state.snapshot!, {
    items,
    authoritativeRefs: [a.ref, b.ref, ...items.map((item) => item.ref)].filter(
      (ref) =>
        !unresolved.some(
          (other) => other.environmentId === ref.environmentId && other.threadId === ref.threadId,
        ),
    ),
    loadingRefs: [],
    errors: [],
    isLoading: false,
    ...diagnostics,
  });
}
async function mount(
  items: readonly DecisionItem[] = [a, b],
  diagnostics: Partial<Omit<Snapshot, "items">> = {},
) {
  write(items, diagnostics);
  await act(async () => {
    await router.load();
    root.render(
      <RegistryContext.Provider value={state.registry!}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </RegistryContext.Provider>,
    );
  });
}
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (entry) => (entry.textContent?.trim() || entry.getAttribute("aria-label")) === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function link(label: string) {
  const result = [...container.querySelectorAll("a")].find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing link: ${label}`);
  return result;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  state.registry = AtomRegistry.make();
  state.registry.set(state.grants!, new Set([primary, secondary]));
  state.approval.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.userInput.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  router = makeRouter();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  state.registry?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("never calls partial loading or detail failures all caught up", async () => {
  await mount([], { isLoading: true, loadingRefs: [a.ref] });
  expect(container.textContent).toContain("Loading decisions…");
  expect(container.textContent).not.toContain("All caught up");
  await act(async () => write([a], { isLoading: true, loadingRefs: [b.ref] }));
  expect(container.textContent).toContain("1 loaded so far");
  expect(button("Approve").disabled).toBe(false);
  await act(async () => write([], { errors: [{ ref: b.ref, message: "Offline" }] }));
  expect(container.textContent).toContain("Some decisions could not be loaded.");
  expect(container.textContent).not.toContain("All caught up");
  expect(link("Open affected thread").getAttribute("href")).toBe("/primary/b");
  await act(async () => write([]));
  expect(container.textContent).toContain(
    "All caught up. No decisions waiting on connected environments.",
  );
});

it("counts actual requests rather than provisional flagged threads", async () => {
  await mount([a, approval("second", secondary, "a", "2026-10-01T01:00:00.000Z"), b]);
  expect(container.textContent).toContain("3 decisions waiting");
  await click("Skip");
  expect(container.textContent).toContain("Run command second");
  expect(container.textContent).not.toContain("Run command a");
  expect(state.approval).not.toHaveBeenCalled();
});

it("blocks cached requests during loading/error but allows an unrelated authoritative destination", async () => {
  await mount([a, b], { isLoading: true, loadingRefs: [a.ref] });
  expect(container.textContent).toContain("Wait for this thread to reconnect before answering.");
  await click("Approve");
  expect(state.approval).not.toHaveBeenCalled();
  await act(async () => write([a, b], { errors: [{ ref: a.ref, message: "Offline" }] }));
  expect(button("Approve").disabled).toBe(true);
  expect(button("More approval options").disabled).toBe(true);
  await click("Skip");
  expect(button("Approve").disabled).toBe(false);
  await click("Approve");
  expect(state.approval).toHaveBeenCalledExactlyOnceWith({
    environmentId: primary,
    input: { threadId: b.ref.threadId, requestId: b.request.requestId, decision: "accept" },
  });
  await act(async () => write([a]));
  expect(button("Approve").disabled).toBe(false);
  expect(container.textContent).not.toContain("Wait for this thread to reconnect");
});

it("rechecks diagnostics at click time before a stale enabled control can dispatch", async () => {
  await mount();
  const enabled = button("Approve");
  await act(async () => {
    write([a, b], { errors: [{ ref: a.ref, message: "Offline" }] });
    enabled.click();
  });
  expect(state.approval).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Wait for this thread to reconnect before answering.");
});

it("uses the destination grant, protects provider overflow and keeps navigation usable", async () => {
  state.registry!.set(state.grants!, new Set([primary]));
  await mount();
  expect(container.textContent).toContain("This connection cannot answer decisions.");
  expect(button("Approve").disabled).toBe(true);
  expect(button("More approval options").disabled).toBe(true);
  await click("Approve");
  await click("More approval options");
  expect(state.approval).not.toHaveBeenCalled();
  expect(link("Go to thread").getAttribute("href")).toBe("/secondary/a");
  await act(async () => state.registry!.set(state.grants!, new Set([primary, secondary])));
  expect(button("Approve").disabled).toBe(false);
  const enabled = button("Approve");
  await act(async () => {
    state.registry!.set(state.grants!, new Set([primary]));
    enabled.click();
  });
  expect(state.approval).not.toHaveBeenCalled();
  await act(async () => state.registry!.set(state.grants!, new Set([primary, secondary])));
  await click("Approve");
  expect(state.approval).toHaveBeenCalledExactlyOnceWith({
    environmentId: secondary,
    input: { threadId: a.ref.threadId, requestId: a.request.requestId, decision: "accept" },
  });
});

it("keeps success locked until projection removal and renders failures without losing the card", async () => {
  let finish: (receipt: Receipt) => void = () => {
    throw new Error("Receipt not started");
  };
  state.approval.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await click("Approve");
  expect(container.textContent).toContain("Sending answer…");
  expect(button("Approve").disabled).toBe(true);
  expect(button("Skip").disabled).toBe(true);
  await act(async () => finish(AsyncResult.failure(Cause.fail(new Error("Try again")))));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Try again");
  expect(button("Approve").disabled).toBe(false);
  await click("Approve");
  expect(container.textContent).toContain("Answer sent. Waiting for the thread to update…");
  expect(container.textContent).toContain("Run command a");
  expect(button("Skip").disabled).toBe(true);
  await act(async () => write([b]));
  expect(container.textContent).toContain("Run command b");
  expect(container.textContent).not.toContain("Try again");
});

it("does not answer dead provider requests but accepts message-mode questions", async () => {
  await mount([{ ...a, request: { ...a.request, responseCapability: "not_resumable" } }]);
  await click("Approve");
  expect(button("More approval options").disabled).toBe(true);
  expect(state.approval).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Provider process is gone");
  expect(link("Go to thread").getAttribute("href")).toBe("/secondary/a");
  await act(async () => write([question("not_resumable")]));
  expect(button("Submit answer").disabled).toBe(true);
  expect(
    [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Incremental"),
    )?.disabled,
  ).toBe(true);
  expect(state.userInput).not.toHaveBeenCalled();
  await act(async () => write([question("message")]));
  const option = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes("Incremental"),
  );
  if (!option) throw new Error("Missing question option");
  await act(async () => option.click());
  await click("Submit answer");
  expect(state.userInput).toHaveBeenCalledExactlyOnceWith({
    environmentId: secondary,
    input: {
      threadId: a.ref.threadId,
      requestId: a.request.requestId,
      answers: { approach: "stable-id" },
    },
  });
});

it.each([
  ["2026-10-14T12:00:00.000Z", "Just now"],
  ["2026-10-14T11:55:00.000Z", "5 min ago"],
  ["2026-10-14T10:00:00.000Z", "2 hr ago"],
  ["2026-10-12T12:00:00.000Z", "2 days ago"],
  ["2026-10-15T12:00:00.000Z", "Just now"],
  ["invalid", "Unknown age"],
])("renders coarse age for %s without an interval", async (timestamp, expected) => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T12:00:00.000Z"));
  const interval = vi.spyOn(globalThis, "setInterval");
  await mount([approval("age", secondary, "a", timestamp)]);
  expect(container.querySelector("time")?.textContent).toBe(expected);
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(timestamp);
  expect(interval).not.toHaveBeenCalled();
});

it("opens the exact environment/thread route from a disabled card", async () => {
  state.registry!.set(state.grants!, new Set());
  await mount([a]);
  await act(async () => {
    link("Go to thread").click();
    await router.load();
  });
  expect(router.state.location.pathname).toBe("/secondary/a");
  expect(container.textContent).toContain("Opened thread");
  expect(state.approval).not.toHaveBeenCalled();
});
