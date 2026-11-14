import { PrimaryConnectionTarget } from "@goat/client-runtime/connection";
import {
  initialGoatBotEnsure,
  resolveGoatBotHomeSelection,
  type GoatBotEnsureState,
} from "@goat/client-runtime/goatBot";
import { createEnvironmentThreadShellAtoms } from "@goat/client-runtime/state/threads";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
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
import {
  goatBotHomeKey,
  goatBotMainAvailability,
  useGoatBotSessions,
  type GoatBotSession,
} from "~/components/goatBot/goatBotSessions";
import { goatBotEnvironmentInputs } from "~/components/goatBot/goatBotEnvironmentInputs";
import { goatBotHomeEnvironmentIdAtom } from "./goatBotHome";
import { environmentPresentations } from "./presentation";

const A = EnvironmentId.make("computer-a");
const B = EnvironmentId.make("computer-b");
const claim = { environmentId: A, claimedAt: 1, claimId: "claim" };
const at = DateTime.makeUnsafe("2026-11-14T00:00:00.000Z");
const project = ProjectId.make("project");
const codex = ProviderInstanceId.make("codex");

function shell(id: string): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: project,
    title: id,
    providerInstanceId: codex,
    modelSelection: { instanceId: codex, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const snapshot: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  projects: [],
  threads: [shell("coding"), shell("worker")],
  archivedThreads: [],
};

/** One machine as the connection layer presents it. */
function machine(
  environmentId: EnvironmentId,
  options: { connected?: boolean; home?: typeof claim | null } = {},
) {
  return {
    environmentId,
    label: environmentId,
    connection: { phase: options.connected === false ? "disconnected" : "connected" },
    serverConfig: {
      environment: {
        label: environmentId,
        capabilities: { channelLedger: true, goatBotHome: true },
      },
      settings: { goatBotHome: options.home === undefined ? claim : options.home },
    },
  };
}

function harness() {
  const registry = AtomRegistry.make();
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      [A, B].map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: id,
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  // Each computer's bot Home links a current task's coding thread; its worker is what the legacy
  // rule hides.
  const shells = createEnvironmentThreadShellAtoms({
    catalogValueAtom,
    snapshotAtom: Atom.family((_id: EnvironmentId) => Atom.make(snapshot)),
    goatBotHomeWork: Atom.family((computer: EnvironmentId) =>
      Atom.make({
        rosterKnown: true,
        byBot: [{ botId: "main" as never, eligible: true, list: "ready" as const }],
        links: [
          {
            taskId: "task" as never,
            environmentId: computer,
            threadId: ThreadId.make("coding"),
            kind: "coding" as const,
          },
        ],
      }),
    ),
    goatBotHomeEnvironmentId: goatBotHomeEnvironmentIdAtom,
    goatBotListedWork: ({ environmentIdsAtom }) =>
      Atom.make((get) =>
        get(environmentIdsAtom).map((id) => ({
          environmentId: id,
          threadId: ThreadId.make("worker"),
        })),
      ),
  });
  registry.mount(shells.goatBotObservationThreadKeysAtom);
  const machines = (...presentations: ReturnType<typeof machine>[]) =>
    registry.set(
      environmentPresentations.presentationsAtom as never,
      new Map(presentations.map((entry) => [entry.environmentId, entry])),
    );
  /** Records what the bot's chat has learned on this connection, as its session hook would. */
  const session = (
    ensure: GoatBotEnsureState,
    options: { notHome?: boolean; port?: unknown } = {},
  ) => {
    const presentations = [
      ...(
        registry.get(environmentPresentations.presentationsAtom as never) as Map<
          EnvironmentId,
          ReturnType<typeof machine>
        >
      ).values(),
    ];
    const inputs = goatBotEnvironmentInputs(presentations as never, A);
    const homeKey = goatBotHomeKey(resolveGoatBotHomeSelection(inputs, null));
    const record: GoatBotSession = {
      homeKey,
      notHome: options.notHome
        ? { homeKey, settingsSnapshot: inputs[0]?.settingsSnapshot ?? null }
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
    // What the Home button shows once the chat has settled on this record.
    return goatBotMainAvailability({
      port: goatBotAppChannelPort,
      environments: inputs,
      botRef: null,
      session: record,
    }).kind;
  };
  const hidden = () => [...registry.get(shells.goatBotObservationThreadKeysAtom)].toSorted();
  return { registry, machines, session, hidden, [Symbol.dispose]: () => registry.dispose() };
}

const key = (computer: EnvironmentId, id: string) => `${computer}:${id}`;
// Computer A's Home governs: its coding thread hides, B keeps the legacy rule.
const GOVERNED = [key(A, "coding"), key(B, "worker")].toSorted();
// dev's legacy set: each computer's worker only.
const LEGACY = [key(A, "worker"), key(B, "worker")].toSorted();
const confirmed: GoatBotEnsureState = {
  state: "confirmed",
  bot: { environmentId: A, threadId: ThreadId.make("bot") },
};

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

it("hides the picked computer's links in every settled state exactly when its Home button is enabled", () => {
  useGoatBotSessions.setState({ sessions: new Map() });
  using h = harness();
  const settled: Array<[string, () => string]> = [
    ["confirmed", () => h.session(confirmed)],
    ["failed", () => h.session({ state: "failed" })],
    ["legacy_active", () => h.session({ state: "legacy_active" })],
    ["not_home held", () => h.session({ state: "idle" }, { notHome: true })],
  ];
  for (const [label, settle] of settled) {
    h.machines(machine(A), machine(B, { home: null }));
    const button = settle();
    expect([label, h.hidden()]).toEqual([label, button === "ready" ? GOVERNED : LEGACY]);
  }
  // Each machine state with the ensure it can settle on: none can start without a claim read back.
  const states: Array<[string, ReturnType<typeof machine>[], GoatBotEnsureState]> = [
    ["unclaimed", [machine(A, { home: null }), machine(B, { home: null })], { state: "idle" }],
    ["not read back", [machine(A, { home: null }), machine(B, { home: claim })], { state: "idle" }],
    ["disconnected", [machine(A, { connected: false }), machine(B, { home: null })], confirmed],
  ];
  for (const [label, machines, ensure] of states) {
    h.machines(...machines);
    const button = h.session(ensure);
    expect([label, button]).not.toEqual([label, "ready"]);
    expect([label, h.hidden()]).toEqual([label, LEGACY]);
  }
});
