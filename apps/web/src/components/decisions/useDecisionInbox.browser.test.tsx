import { RegistryContext } from "@effect/atom-react";
import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import type { AtomCommandResult } from "@goat/client-runtime/state/runtime";
import { EnvironmentId, RuntimeRequestId, ThreadId, type ScopedThreadRef } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Snapshot = {
  items: readonly DecisionItem[];
  authoritativeRefs: readonly ScopedThreadRef[];
  loadingRefs: readonly ScopedThreadRef[];
  errors: readonly { ref: ScopedThreadRef; message: string }[];
  isLoading: boolean;
};
type Run = (...args: unknown[]) => Promise<AtomCommandResult<void, Error>>;
const state = vi.hoisted<{
  registry: AtomRegistry.AtomRegistry | null;
  snapshot: Atom.Writable<Snapshot> | null;
  allowed: Set<EnvironmentId>;
  approval: ReturnType<typeof vi.fn<Run>>;
  userInput: ReturnType<typeof vi.fn<Run>>;
}>(() => ({
  registry: null,
  snapshot: null,
  allowed: new Set<EnvironmentId>(),
  approval: vi.fn<(...args: unknown[]) => Promise<AtomCommandResult<void, Error>>>(),
  userInput: vi.fn<(...args: unknown[]) => Promise<AtomCommandResult<void, Error>>>(),
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
    decisionInbox: { itemsAtom: state.snapshot },
  };
});
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    respondToApproval: "approval",
    respondToUserInput: "userInput",
  },
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
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (id: EnvironmentId) => state.allowed.has(id),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "approval" ? state.approval : state.userInput),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { answerDecision: "decisionAnswer" } }));

import { useDecisionInbox } from "./useDecisionInbox";

const env = EnvironmentId.make("secondary");
function item(
  id: string,
  createdAt = "2026-10-01T00:00:00.000Z",
  environmentId = env,
): Extract<DecisionItem, { kind: "approval" }> {
  const ref = { environmentId, threadId: ThreadId.make("same-thread") };
  return {
    id: JSON.stringify([environmentId, ref.threadId, id]),
    ref,
    routing: { routedTo: "person" },
    kind: "approval",
    createdAt,
    request: {
      requestId: RuntimeRequestId.make(id),
      requestKind: "command",
      createdAt,
      responseCapability: "live",
    },
  };
}
const a = item("a");
const b = item("b", "2026-10-02T00:00:00.000Z");
const c = item("c", "2026-10-03T00:00:00.000Z");
let root: Root | undefined;
let latest: ReturnType<typeof useDecisionInbox> | undefined;
function Harness() {
  const value = useDecisionInbox();
  useLayoutEffect(() => {
    latest = value;
  });
  return <output>{value.current?.id}</output>;
}
function inbox() {
  if (!latest) throw new Error("Inbox has not mounted");
  return latest;
}
function write(items: readonly DecisionItem[], diagnostics: Partial<Omit<Snapshot, "items">> = {}) {
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
    root = createRoot(document.createElement("div"));
    root.render(
      <RegistryContext.Provider value={state.registry!}>
        <Harness />
      </RegistryContext.Provider>,
    );
  });
}
function deferred() {
  let finish: (result: AtomCommandResult<void, Error>) => void = () => {
    throw new Error("Missing receipt resolver");
  };
  const promise = new Promise<AtomCommandResult<void, Error>>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.registry = AtomRegistry.make();
  state.allowed.clear();
  state.allowed.add(env);
  state.approval.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.userInput.mockReset().mockResolvedValue(AsyncResult.success(undefined));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  latest = undefined;
  state.registry?.dispose();
  vi.unstubAllGlobals();
});

it("holds the current request and duplicate lock until live projection removes it", async () => {
  const receipt = deferred();
  state.approval.mockReturnValueOnce(receipt.promise);
  await mount();
  let pending: Promise<void> | undefined;
  await act(async () => {
    pending = inbox().submit(a.id, "accept");
    await inbox().submit(a.id, "accept");
  });
  expect(state.approval).toHaveBeenCalledTimes(1);
  expect(inbox().submissions[a.id]?.phase).toBe("submitting");
  await act(async () => {
    receipt.finish(AsyncResult.success(undefined));
    await pending;
  });
  expect(inbox().current?.id).toBe(a.id);
  expect(inbox().submissions[a.id]?.phase).toBe("awaitingProjection");
  await act(async () => {
    await inbox().submit(a.id, "accept");
  });
  expect(state.approval).toHaveBeenCalledTimes(1);
  await act(async () => write([b]));
  expect(inbox().current?.id).toBe(b.id);
  expect(inbox().submissions[a.id]).toBeUndefined();
});

it("preserves free text on failure and retries in the same destination", async () => {
  const question: DecisionItem = {
    ...a,
    kind: "user_input",
    request: {
      requestId: a.request.requestId,
      createdAt: a.createdAt,
      dismissible: false,
      responseCapability: "message",
      questions: [],
    },
  };
  state.userInput.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error("Connection failed"))),
  );
  await mount([question]);
  await act(async () => {
    inbox().setAnswers(a.id, { approach: { customAnswer: "Keep my answer" } });
    await inbox().submit(a.id, { approach: "Keep my answer" });
  });
  expect(inbox().drafts[a.id]).toEqual({ approach: { customAnswer: "Keep my answer" } });
  expect(inbox().submissions[a.id]).toEqual({ phase: "failed", message: "Connection failed" });
  await act(async () => {
    await inbox().submit(a.id, { approach: "Keep my answer" });
  });
  expect(state.userInput.mock.calls.map(([target]) => target)).toEqual([
    {
      environmentId: env,
      input: {
        threadId: a.ref.threadId,
        requestId: a.request.requestId,
        answers: { approach: "Keep my answer" },
      },
    },
    {
      environmentId: env,
      input: {
        threadId: a.ref.threadId,
        requestId: a.request.requestId,
        answers: { approach: "Keep my answer" },
      },
    },
  ]);
  expect(inbox().submissions[a.id]?.phase).toBe("awaitingProjection");
});

it("prunes a late receipt under its original ID without changing the next draft or error", async () => {
  const receipt = deferred();
  state.approval.mockReturnValueOnce(receipt.promise);
  await mount();
  let pending: Promise<void> | undefined;
  await act(async () => {
    pending = inbox().submit(a.id, "accept");
  });
  await act(async () => write([b]));
  state.approval.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("B failed"))));
  await act(async () => {
    inbox().setAnswers(b.id, { q: { customAnswer: "B draft" } });
    await inbox().submit(b.id, "decline");
  });
  await act(async () => {
    receipt.finish(AsyncResult.failure(Cause.fail(new Error("Late A"))));
    await pending;
  });
  expect(inbox().current?.id).toBe(b.id);
  expect(inbox().drafts[b.id]).toEqual({ q: { customAnswer: "B draft" } });
  expect(inbox().submissions[b.id]).toEqual({ phase: "failed", message: "B failed" });
  expect(inbox().submissions[a.id]).toBeUndefined();
});

it("cycles skip order without RPC and restores drafts when revisiting", async () => {
  await mount([c, a, b]);
  await act(async () => {
    inbox().setAnswers(a.id, { q: { customAnswer: "Saved" } });
    inbox().skip();
  });
  expect(inbox().current?.id).toBe(b.id);
  await act(async () => inbox().skip());
  expect(inbox().current?.id).toBe(c.id);
  expect(inbox().ordered.map((entry) => entry.id)).toEqual([c.id, a.id, b.id]);
  await act(async () => inbox().skip());
  expect(inbox().current?.id).toBe(a.id);
  expect(inbox().drafts[a.id]).toEqual({ q: { customAnswer: "Saved" } });
  await act(async () => inbox().skip());
  expect(inbox().ordered.map((entry) => entry.id)).toEqual([b.id, c.id, a.id]);
  expect(state.approval).not.toHaveBeenCalled();
  expect(state.userInput).not.toHaveBeenCalled();
});

it("keeps the editing cursor on older arrivals and reconciles when it leaves", async () => {
  await mount();
  await act(async () => inbox().skip());
  const x = item("x", "2026-09-01T00:00:00.000Z");
  await act(async () => write([x, a, b]));
  expect(inbox().current?.id).toBe(b.id);
  expect(inbox().position).toBe(2);
  await act(async () => write([x, a]));
  expect(inbox().current?.id).toBe(x.id);
  expect(inbox().position).toBe(1);
});

it("chooses the oldest initial decision after staggered environment responses", async () => {
  const remote = item("remote", "2026-09-01T00:00:00.000Z", EnvironmentId.make("ssh"));
  await mount([b], { isLoading: true, loadingRefs: [remote.ref] });
  expect(inbox().current?.id).toBe(b.id);
  await act(async () => write([b, remote]));
  expect(inbox().current?.id).toBe(remote.id);
  expect(inbox().position).toBe(1);
});

it.each(["type", "skip", "submit"])(
  "pins partial results on the first %s interaction",
  async (action) => {
    const remote = item("remote", "2026-09-01T00:00:00.000Z", EnvironmentId.make("ssh"));
    await mount([b, c], { isLoading: true, loadingRefs: [remote.ref] });
    await act(async () => {
      if (action === "type") inbox().setAnswers(b.id, { q: { customAnswer: "In progress" } });
      else if (action === "skip") inbox().skip();
      else await inbox().submit(b.id, "accept");
    });
    await act(async () => write([remote, b, c]));
    expect(inbox().current?.id).toBe(action === "skip" ? c.id : b.id);
  },
);

it("keeps drafts and skip positions through disconnect, other skips and reconnect", async () => {
  const local = item("local", "2026-10-04T00:00:00.000Z", EnvironmentId.make("local"));
  const nextLocal = item("next-local", "2026-10-05T00:00:00.000Z", local.ref.environmentId);
  await mount([a, b, local, nextLocal]);
  await act(async () => {
    inbox().setAnswers(a.id, { q: { customAnswer: "Keep across disconnect" } });
    inbox().skip();
  });
  await act(async () => write([local, nextLocal], { authoritativeRefs: [local.ref] }));
  expect(inbox().drafts[a.id]?.q?.customAnswer).toBe("Keep across disconnect");
  await act(async () => inbox().skip());
  await act(async () => write([a, b, local, nextLocal]));
  expect(inbox().ordered.map((entry) => entry.id)).toEqual([b.id, nextLocal.id, a.id, local.id]);
  expect(inbox().drafts[a.id]?.q?.customAnswer).toBe("Keep across disconnect");
  await act(async () => write([b, local, nextLocal]));
  expect(inbox().drafts[a.id]).toBeUndefined();
});

it("keeps the receipt lock through disconnect and reconnect until live removal", async () => {
  await mount();
  await act(async () => inbox().submit(a.id, "accept"));
  await act(async () => write([], { authoritativeRefs: [] }));
  expect(inbox().submissions[a.id]?.phase).toBe("awaitingProjection");
  await act(async () => write([a, b]));
  await act(async () => inbox().submit(a.id, "accept"));
  expect(state.approval).toHaveBeenCalledTimes(1);
  await act(async () => write([b]));
  expect(inbox().submissions[a.id]).toBeUndefined();
});

it("retains hidden drafts during loading and errors, pruning only authoritative removal", async () => {
  await mount();
  await act(async () => inbox().setAnswers(a.id, { q: { customAnswer: "Retained" } }));
  await act(async () => write([b], { isLoading: true, loadingRefs: [a.ref] }));
  expect(inbox().drafts[a.id]).toBeDefined();
  await act(async () => write([b], { errors: [{ ref: a.ref, message: "Offline" }] }));
  expect(inbox().drafts[a.id]).toBeDefined();
  await act(async () => write([a, b]));
  expect(inbox().drafts[a.id]).toEqual({ q: { customAnswer: "Retained" } });
  await act(async () => write([b]));
  expect(inbox().drafts[a.id]).toBeUndefined();
});

it("rechecks sync, capability and destination grants even through retained callbacks", async () => {
  const primary = EnvironmentId.make("primary");
  const other = item("a", a.createdAt, primary);
  state.allowed.add(primary);
  await mount([a, other]);
  const submit = inbox().submit;
  await act(async () => {
    write([a, other], { isLoading: true, loadingRefs: [a.ref] });
    await submit(a.id, "accept");
  });
  expect(state.approval).not.toHaveBeenCalled();
  await act(async () => {
    write([a, other], { errors: [{ ref: a.ref, message: "Offline" }] });
    await submit(a.id, "accept");
    await submit(other.id, "accept");
  });
  expect(state.approval).toHaveBeenCalledTimes(1);
  expect(state.approval.mock.calls[0]?.[0]).toMatchObject({ environmentId: primary });
  state.allowed.delete(env);
  await act(async () => {
    write([a, other]);
    await submit(a.id, "accept");
  });
  expect(inbox().submissions[a.id]).toEqual({
    phase: "failed",
    message: "This connection cannot answer decisions.",
  });
  expect(state.approval).toHaveBeenCalledTimes(1);
  state.allowed.add(env);
  await act(async () => {
    write([{ ...a, request: { ...a.request, responseCapability: "not_resumable" } }, other]);
    await submit(a.id, "accept");
  });
  expect(state.approval).toHaveBeenCalledTimes(1);
  await act(async () => {
    write([a, other]);
    await submit(a.id, "accept");
  });
  expect(state.approval).toHaveBeenCalledTimes(2);
  expect(state.approval.mock.calls[1]?.[0]).toMatchObject({ environmentId: env });
});
