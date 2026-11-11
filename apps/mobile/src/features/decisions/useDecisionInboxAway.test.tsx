import "../../testing/decisionNativeHarness";
import { RegistryContext } from "@effect/atom-react";
import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Snapshot = {
  readonly items: ReadonlyArray<DecisionItem>;
  readonly authoritativeRefs: ReadonlyArray<ScopedThreadRef>;
  readonly loadingRefs: ReadonlyArray<ScopedThreadRef>;
  readonly errors: ReadonlyArray<{ readonly ref: ScopedThreadRef; readonly message: string }>;
  readonly isLoading: boolean;
  readonly feedEnvironments: ReadonlyArray<EnvironmentId>;
  readonly catalogEnvironments: ReadonlyArray<EnvironmentId>;
};
const fixture = vi.hoisted(() => ({ items: null as Atom.Writable<Snapshot> | null }));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  fixture.items = Atom.make<Snapshot>({
    items: [],
    authoritativeRefs: [],
    loadingRefs: [],
    errors: [],
    isLoading: false,
    feedEnvironments: [],
    catalogEnvironments: [],
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
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { approval, durable, envA, envB } from "./decisionInboxFixtures";
import { useDecisionInbox, useDecisionInboxSessionState } from "./useDecisionInbox";

const away = durable();
const answerable = approval(envB, approval().ref.threadId, "2026-10-02T00:00:00.000Z");
let registry: AtomRegistry.AtomRegistry;
let root: Root;
let latest: ReturnType<typeof useDecisionInbox> | undefined;
function Probe() {
  const value = useDecisionInbox(useDecisionInboxSessionState(), () => true);
  useLayoutEffect(() => {
    latest = value;
  });
  return null;
}
function inbox() {
  if (!latest) throw new Error("Inbox not mounted");
  return latest;
}
async function write(items: ReadonlyArray<DecisionItem>, environments: Partial<Snapshot>) {
  await act(async () =>
    registry.set(fixture.items!, {
      ...registry.get(fixture.items!),
      items,
      authoritativeRefs: items.map((item) => item.ref),
      ...environments,
    }),
  );
}
beforeEach(async () => {
  registry = AtomRegistry.make();
  root = createRoot(document.createElement("div"));
  await write([away, answerable], { feedEnvironments: [envB], catalogEnvironments: [envA, envB] });
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

it("skips a decision whose environment is away to reach an answerable one", async () => {
  expect(inbox().current?.id).toBe(away.id);
  expect(inbox().paused).toBe(true);
  await act(async () => inbox().skip());
  expect(inbox().current?.id).toBe(answerable.id);
  expect(inbox().paused).toBe(false);
});

it("drops a selected away decision once its environment leaves the catalog", async () => {
  expect(inbox().current?.id).toBe(away.id);
  await write([answerable], { catalogEnvironments: [envB] });
  expect(inbox().current?.id).toBe(answerable.id);
  expect(inbox().paused).toBe(false);
});
