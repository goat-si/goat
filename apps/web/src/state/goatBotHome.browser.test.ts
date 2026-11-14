import {
  initialGoatBotEnsure,
  resolveGoatBotHomeSelection,
  type GoatBotEnsureState,
} from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

// The machines this client sees, as presentations; the test edits them like connection updates.
vi.mock("./presentation", async () => {
  const { Atom: A } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: A.make(new Map()) } };
});
vi.mock("./environmentProjection", () => ({
  projectEnvironmentPresentation: (_environmentId: unknown, presentation: unknown) => presentation,
}));
vi.mock("./primaryEnvironment", async () => {
  const { Atom: A } = await import("effect/reactivity");
  const { EnvironmentId: Id } = await import("@goat/contracts");
  return { primaryEnvironmentIdAtom: A.make(Id.make("computer-a")) };
});
// Stands in for the app's one port; only its identity matters to the sessions it is compared with.
vi.mock("~/components/goatBot/goatBotAppChannelPort", () => ({
  goatBotAppChannelPort: { app: true },
}));

import { goatBotAppChannelPort } from "~/components/goatBot/goatBotAppChannelPort";
import { goatBotEnvironmentInputs } from "~/components/goatBot/goatBotEnvironmentInputs";
import {
  goatBotGoverningEnvironmentId,
  goatBotHomeKey,
  goatBotMainAvailability,
  useGoatBotSessions,
  type GoatBotSession,
} from "~/components/goatBot/goatBotSessions";
import {
  A,
  B,
  claim,
  confirmed,
  GOVERNED,
  hiddenFromThreadsAtom,
  LEGACY,
  machine,
} from "./goatBotHome.test-support";
import { environmentPresentations } from "./presentation";

function harness() {
  const registry = AtomRegistry.make();
  const hiddenAtom = hiddenFromThreadsAtom();
  registry.mount(hiddenAtom);
  const presentations = () => [
    ...(
      registry.get(environmentPresentations.presentationsAtom as never) as Map<
        EnvironmentId,
        ReturnType<typeof machine>
      >
    ).values(),
  ];
  const inputs = () => goatBotEnvironmentInputs(presentations() as never, A);
  const machines = (...entries: ReturnType<typeof machine>[]) =>
    registry.set(
      environmentPresentations.presentationsAtom as never,
      new Map(entries.map((entry) => [entry.environmentId, entry])),
    );
  /** Records what the bot's chat learned on this connection, as its session hook would. */
  const session = (
    ensure: GoatBotEnsureState,
    options: { notHome?: boolean; port?: unknown } = {},
  ): GoatBotSession => {
    const homeKey = goatBotHomeKey(resolveGoatBotHomeSelection(inputs(), null));
    const record: GoatBotSession = {
      homeKey,
      notHome: options.notHome
        ? { homeKey, settingsSnapshot: inputs()[0]?.settingsSnapshot ?? null }
        : null,
      connected: true,
      capability: true,
      generation: 1,
      machine: { ...initialGoatBotEnsure, generation: "g", ensure },
      port: (options.port === undefined ? goatBotAppChannelPort : options.port) as never,
      canOperate: true,
      legacyAutoRetried: false,
      queue: {} as never,
      members: new Set(),
    };
    useGoatBotSessions.setState({ sessions: new Map([[A, record]]) });
    return record;
  };
  const hidden = () => [...registry.get(hiddenAtom)].toSorted();
  return { inputs, machines, session, hidden, [Symbol.dispose]: () => registry.dispose() };
}

it("governs the picked computer before its chat opens, and keeps dev's set wherever its Home cannot open", () => {
  useGoatBotSessions.setState({ sessions: new Map() });
  using h = harness();
  h.machines(machine(A), machine(B, { home: null }));
  // No ensure recorded yet, Home claimed and read back: reachable by opening the chat.
  expect(h.hidden()).toEqual(GOVERNED);
  // The sidebar's session before any chat: no port, no ensure.
  h.session({ state: "idle" }, { port: null });
  expect(h.hidden()).toEqual(GOVERNED);
  // An ensure in flight still counts; it is the stated limit.
  h.session({ state: "pending" });
  expect(h.hidden()).toEqual(GOVERNED);
  // Home unclaimed (a client without settings-write cannot claim it): legacy.
  useGoatBotSessions.setState({ sessions: new Map() });
  h.machines(machine(A, { home: null }), machine(B, { home: null }));
  expect(h.hidden()).toEqual(LEGACY);
  // The claim is published on B but A has not read it back: the ensure cannot start, legacy.
  h.machines(machine(A, { home: null }), machine(B, { home: claim }));
  expect(h.hidden()).toEqual(LEGACY);
  h.machines(machine(A), machine(B, { home: null }));
  expect(h.hidden()).toEqual(GOVERNED);
  // A not_home refusal holds the ensure: legacy.
  h.session({ state: "idle" }, { notHome: true });
  expect(h.hidden()).toEqual(LEGACY);
  h.session({ state: "failed", message: "no" });
  expect(h.hidden()).toEqual(LEGACY);
  h.session({ state: "legacy_active" });
  expect(h.hidden()).toEqual(LEGACY);
  h.session(confirmed);
  expect(h.hidden()).toEqual(GOVERNED);
  // Confirmed, then the connection drops: legacy.
  h.machines(machine(A, { connected: false }), machine(B, { home: null }));
  expect(h.hidden()).toEqual(LEGACY);
});

it.each([
  ["pending", { state: "pending" }],
  ["confirmed", confirmed],
] as const)(
  "stops governing when the Home read-back is lost while the ensure is %s",
  (_label, ensure) => {
    useGoatBotSessions.setState({ sessions: new Map() });
    using h = harness();
    // A read back its claim and the chat recorded this ensure on that claim.
    h.machines(machine(A), machine(B, { home: null }));
    h.session(ensure);
    expect(h.hidden()).toEqual(GOVERNED);
    // A's settings lose the claim while B still advertises the same winner: same claim key and
    // connection, so the session still matches, but A's Home prerequisite is now false.
    h.machines(machine(A, { home: null }), machine(B, { home: claim }));
    expect(h.hidden()).toEqual(LEGACY);
  },
);

it("stops governing when a not_home refusal is recorded while an ensure is pending", () => {
  useGoatBotSessions.setState({ sessions: new Map() });
  using h = harness();
  h.machines(machine(A), machine(B, { home: null }));
  h.session({ state: "pending" });
  expect(h.hidden()).toEqual(GOVERNED);
  h.session({ state: "pending" }, { notHome: true });
  expect(h.hidden()).toEqual(LEGACY);
});

it("the governing helper names the picked computer exactly when the availability helper is ready, in every settled state", () => {
  useGoatBotSessions.setState({ sessions: new Map() });
  using h = harness();
  const agree = (label: string, record: GoatBotSession, port: unknown = goatBotAppChannelPort) => {
    const input = { port: port as never, environments: h.inputs(), botRef: null, session: record };
    const ready = goatBotMainAvailability(input).kind === "ready";
    expect([label, goatBotGoverningEnvironmentId(input)]).toEqual([label, ready ? A : null]);
    return ready;
  };
  h.machines(machine(A), machine(B, { home: null }));
  expect(agree("confirmed", h.session(confirmed))).toBe(true);
  expect(agree("failed", h.session({ state: "failed" }))).toBe(false);
  expect(agree("legacy_active", h.session({ state: "legacy_active" }))).toBe(false);
  expect(agree("not_home held", h.session({ state: "idle" }, { notHome: true }))).toBe(false);
  // No port at all: GOAT Bot is not offered.
  expect(agree("no port", h.session(confirmed), null)).toBe(false);
  // Each machine state with the ensure it can settle on: none can start without a claim read back.
  const states: Array<[string, ReturnType<typeof machine>[], GoatBotEnsureState]> = [
    ["unclaimed", [machine(A, { home: null }), machine(B, { home: null })], { state: "idle" }],
    ["not read back", [machine(A, { home: null }), machine(B, { home: claim })], { state: "idle" }],
    ["disconnected", [machine(A, { connected: false }), machine(B, { home: null })], confirmed],
  ];
  for (const [label, machines, ensure] of states) {
    h.machines(...machines);
    expect(agree(label, h.session(ensure))).toBe(false);
    expect([label, h.hidden()]).toEqual([label, LEGACY]);
  }
});
