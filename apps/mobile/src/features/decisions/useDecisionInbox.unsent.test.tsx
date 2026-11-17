import "../../testing/decisionNativeHarness";
import { RegistryContext } from "@effect/atom-react";
import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import { userInputDraftKey } from "@goat/client-runtime/state/thread-requests";
import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

// O2/O4, the mobile half: the Decisions inbox keeps a typed answer when its question is stopped
// (it writes where the thread's question card keeps answers, so the one resolution listener
// returns it to the thread's draft, as web's inbox does), and "/side ..." or "/btw ..." typed as
// an answer opens the thread's side chat instead of answering (coordinator D1 (b)).
type Snapshot = {
  readonly items: ReadonlyArray<DecisionItem>;
  readonly authoritativeRefs: ReadonlyArray<ScopedThreadRef>;
  readonly loadingRefs: ReadonlyArray<ScopedThreadRef>;
  readonly errors: ReadonlyArray<{ readonly ref: ScopedThreadRef; readonly message: string }>;
  readonly isLoading: boolean;
  readonly feedEnvironments: ReadonlyArray<EnvironmentId>;
};
const fixture = vi.hoisted(() => ({
  items: null as Atom.Writable<Snapshot> | null,
  userInput: vi.fn(),
  open: vi.fn(),
  canStart: true,
}));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  fixture.items = Atom.make<Snapshot>({
    items: [],
    authoritativeRefs: [],
    loadingRefs: [],
    errors: [],
    isLoading: false,
    feedEnvironments: [],
  }).pipe(Atom.keepAlive);
  return {
    decisionInbox: { itemsAtom: fixture.items },
    threadEnvironment: { respondToApproval: "approval", respondToUserInput: "userInput" },
    environmentThreads: { stateAtom: () => Atom.make(0) },
  };
});
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { answerDecision: "decision" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "userInput" ? fixture.userInput : vi.fn()),
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { userInputDraftsByRequestKeyAtom } from "../../state/user-input-drafts";
import { requestId, userInput } from "./decisionInboxFixtures";
import { useDecisionInbox, useDecisionInboxSessionState } from "./useDecisionInbox";

const item = userInput();
let registry: AtomRegistry.AtomRegistry;
let root: Root;
let latest: ReturnType<typeof useDecisionInbox> | undefined;
function Probe() {
  const value = useDecisionInbox(useDecisionInboxSessionState(), () => true, {
    available: () => fixture.canStart,
    hasAttachmentsOrContext: () => false,
    open: fixture.open,
  });
  useLayoutEffect(() => {
    latest = value;
  });
  return null;
}
function inbox() {
  if (!latest) throw new Error("Inbox not mounted");
  return latest;
}
beforeEach(async () => {
  fixture.userInput.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  fixture.open.mockReset().mockResolvedValue(true);
  fixture.canStart = true;
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {});
  registry = AtomRegistry.make();
  registry.set(fixture.items!, {
    ...registry.get(fixture.items!),
    items: [item],
    authoritativeRefs: [item.ref],
  });
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  latest = undefined;
  registry.dispose();
});

async function typeAnswer(text: string) {
  await act(async () => inbox().onChangeCustomAnswer(requestId, "q", text));
}

it("keeps a typed answer where the thread returns unsent answers from", async () => {
  await typeAnswer("Purple");
  const key = userInputDraftKey(item.ref.environmentId, item.ref.threadId, requestId);
  expect(appAtomRegistry.get(userInputDraftsByRequestKeyAtom)[key]?.q?.customAnswer).toBe("Purple");
});

it("opens the thread's side chat for /side and sends no answer", async () => {
  await typeAnswer("/side why?");
  await act(async () => inbox().onSubmit());
  expect(fixture.userInput).not.toHaveBeenCalled();
  expect(fixture.open).toHaveBeenCalledWith(item.ref, "why?");
  expect(inbox().drafts.q?.customAnswer ?? "").toBe("");
});

it("treats /btw like /side", async () => {
  await typeAnswer("/btw why?");
  await act(async () => inbox().onSubmit());
  expect(fixture.userInput).not.toHaveBeenCalled();
  expect(fixture.open).toHaveBeenCalledWith(item.ref, "why?");
});

it("sends /side as the answer where no side chat can start", async () => {
  fixture.canStart = false;
  await typeAnswer("/side why?");
  await act(async () => inbox().onSubmit());
  expect(fixture.open).not.toHaveBeenCalled();
  expect(fixture.userInput).toHaveBeenCalledOnce();
});
