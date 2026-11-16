import { useLayoutEffect } from "react";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@goat/contracts";

const answers = vi.hoisted(() => new WeakMap<object, { bots: unknown }>());
const answerOf = (bots: ReadonlyArray<Record<string, unknown>>) => {
  let answer = answers.get(bots);
  if (answer === undefined) answers.set(bots, (answer = { bots }));
  return answer;
};
const state = vi.hoisted(() => ({
  capabilities: {} as Record<string, boolean>,
  calls: [] as string[],
  bots: [] as ReadonlyArray<Record<string, unknown>>,
  connected: true,
  botRef: null as { readonly environmentId: string; readonly threadId: string } | null,
  environmentId: "env",
  // A bot-list read refused for access; the query keeps its earlier answer beside it.
  cause: null as unknown,
  // The computer's Slack connections, as its settings read answers.
  slack: null as null | ReadonlyArray<{ enabled: boolean }>,
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({
    environments: [
      {
        environmentId: state.environmentId,
        connected: state.connected,
        supportsChannelLedger: true,
      },
    ],
    botRef: state.botRef,
  }),
}));
vi.mock("../../state/use-thread-detail", () => ({ useThreadVisibleTurnItems: () => [] }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        state.environmentId,
        { serverConfig: { environment: { capabilities: state.capabilities } } },
      ],
    ]),
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string | null) => {
    if (query) state.calls.push(query);
    // An offline computer answers nothing. Like a real read, an answer keeps its identity.
    const profiles = query === "profiles" && state.connected ? answerOf(state.bots) : null;
    const refused = query === "profiles" ? state.cause : null;
    return {
      data: query === "threads" ? { rows: [] } : query === "slack" ? state.slack : profiles,
      successResult: profiles === null || refused !== null ? null : { value: profiles },
      cause: refused,
      error: null,
      isPending: false,
      isSuccess: query !== null && refused === null,
      refresh: vi.fn(),
    };
  },
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listBots: () => "profiles",
    listBotThreads: () => "threads",
    slackSettings: () => "slack",
    updateTaskView: {},
  },
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
// No computer is connected in these presentations, so no reader looks at the bot list beyond the roster.
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(new Map()) } };
});
// The app's computers. Each test's registry holds its own catalog value; "env" is listed unless a test says not.
const catalog = vi.hoisted(() => ({
  atom: null as null | import("effect/reactivity").Atom.Writable<unknown>,
}));
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  catalog.atom = Atom.make<unknown>({
    isReady: true,
    entries: new Map(["env", "first", "second"].map((id) => [id, { enabled: true }])),
  });
  return { environmentCatalog: { catalogValueAtom: catalog.atom } };
});
import { useMobileBotRoster, useMobileGoatBotMember } from "./useMobileBotRoster";
import { followKeptPerComputerCatalog, resetKeptPerComputerForTests } from "./useKeptPerComputer";

let value: ReturnType<typeof useMobileBotRoster>;
function Probe() {
  value = useMobileBotRoster();
  return null;
}
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  state.calls = [];
  state.capabilities = {};
  state.bots = [];
  state.connected = true;
  state.botRef = null;
  state.environmentId = "env";
  state.cause = null;
  state.slack = null;
  resetKeptPerComputerForTests();
});

it("queries only capabilities advertised by the selected bot environment, and never the bot's tasks", async () => {
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root?.render(<Probe />));
  expect(value.environmentId).toBe(EnvironmentId.make("env"));
  expect(value.bots).toEqual([{ kind: "main", profile: null }]);
  expect(state.calls).toEqual([]);
  state.capabilities = { goatBotProfiles: true, goatBotTaskThreads: true };
  await act(async () => root?.render(<Probe />));
  // The list holds bots only; each bot's tasks are read by its own home sheet.
  // (Each render asks again for the same read; keeping its answer for offline is one more render.)
  expect(new Set(state.calls)).toEqual(new Set(["profiles"]));
});

it("names the main bot's chat with its renamed profile", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = [
    { botId: "main", role: "main", name: "Goaty", createdAt: "2026-11-01T00:00:00.000Z" },
    { botId: "echo", role: "member", name: "Echo", createdAt: "2026-11-02T00:00:00.000Z" },
  ];
  let named: ReturnType<typeof useMobileGoatBotMember> | undefined;
  function NameProbe(props: { readonly botId?: string }) {
    named = useMobileGoatBotMember(props.botId);
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<NameProbe />));
  expect(named?.member).toBeNull();
  expect(named?.main?.name).toBe("Goaty");
  await act(async () => root?.render(<NameProbe botId="echo" />));
  expect(named?.member?.name).toBe("Echo");
});

it("reads no bot list while the computer is offline, for the main bot or a named member", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.connected = false;
  // A saved home keeps its computer selected while it is offline.
  state.botRef = { environmentId: "env", threadId: "bot" };
  function NameProbe(props: { readonly botId?: string }) {
    useMobileGoatBotMember(props.botId);
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<NameProbe />));
  expect(state.calls).toEqual([]);
  await act(async () => root?.render(<NameProbe botId="echo" />));
  expect(state.calls).toEqual([]);
});

const echoBots = [
  { botId: "main", role: "main", name: "GOAT Bot", createdAt: "2026-11-01T00:00:00.000Z" },
  { botId: "echo", role: "member", name: "Echo", createdAt: "2026-11-02T00:00:00.000Z" },
];
const memberNamesOf = (bots: typeof value.bots) =>
  bots.flatMap((entry) => (entry.kind === "member" ? [entry.profile.name] : []));
const memberNames = () => memberNamesOf(value.bots);

it("keeps the bots listed while their computer is offline, and still knows it has members", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = echoBots;
  // A saved bot keeps its computer selected while that computer is offline.
  state.botRef = { environmentId: "env", threadId: "bot" };
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Probe />));
  expect(memberNames()).toEqual(["Echo"]);
  state.connected = false;
  await act(async () => root?.render(<Probe />));
  expect(memberNames()).toEqual(["Echo"]);
  expect(value.supportsMembers).toBe(true);
  expect(value.refreshBots).toBeNull();
});

it("a member chat opened for the first time while offline finds its bot in the list read before", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = echoBots;
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Probe />));
  await act(async () => root?.unmount());
  state.connected = false;
  state.botRef = { environmentId: "env", threadId: "bot" };
  let named: ReturnType<typeof useMobileGoatBotMember> | undefined;
  function NameProbe() {
    named = useMobileGoatBotMember("echo");
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<NameProbe />));
  expect(named?.member?.name).toBe("Echo");
  expect(named?.missing).toBe(false);
});

it("never shows one computer's kept bots for another", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = echoBots;
  state.environmentId = "first";
  state.botRef = { environmentId: "first", threadId: "bot" };
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Probe />));
  expect(memberNames()).toEqual(["Echo"]);
  state.connected = false;
  state.environmentId = "second";
  state.botRef = { environmentId: "second", threadId: "bot" };
  await act(async () => root?.render(<Probe />));
  expect(memberNames()).toEqual([]);
  state.environmentId = "first";
  state.botRef = { environmentId: "first", threadId: "bot" };
  await act(async () => root?.render(<Probe />));
  expect(memberNames()).toEqual(["Echo"]);
});

it("forgets a computer's kept bots when it leaves the app, even removed while connected, so adding it again starts empty", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = echoBots;
  state.botRef = { environmentId: "env", threadId: "bot" };
  const registry = AtomRegistry.make();
  // The app installs this with its registry; the test's own registry needs it too.
  const stopFollowing = followKeptPerComputerCatalog(registry);
  const listed = (ids: string[]) => ({
    isReady: true,
    entries: new Map(ids.map((id) => [id, { enabled: true }])),
  });
  registry.set(catalog.atom!, listed(["env"]));
  root = createRoot(document.createElement("div"));
  const rendered = () => (
    <RegistryContext value={registry}>
      <Probe />
    </RegistryContext>
  );
  await act(async () => root?.render(rendered()));
  expect(memberNames()).toEqual(["Echo"]);
  // Removed while its live answer is still on screen: nothing writes it back.
  await act(async () => registry.set(catalog.atom!, listed([])));
  await act(async () => root?.render(rendered()));
  state.connected = false;
  await act(async () => root?.render(rendered()));
  await act(async () => registry.set(catalog.atom!, listed(["env"])));
  await act(async () => root?.render(rendered()));
  expect(memberNames()).toEqual([]);
  stopFollowing();
});

it("before a computer's capabilities are read, member support is unknown rather than missing", async () => {
  state.connected = false;
  root = createRoot(document.createElement("div"));
  state.capabilities = undefined as unknown as Record<string, boolean>;
  await act(async () => root?.render(<Probe />));
  expect(value.membersUnknown).toBe(true);
  expect(value.supportsMembers).toBe(false);
});

it("an answer already on its way to the kept list is not kept once its computer has left the app", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = echoBots;
  state.botRef = { environmentId: "env", threadId: "bot" };
  const registry = AtomRegistry.make();
  // The app installs this with its registry; the test's own registry needs it too.
  const stopFollowing = followKeptPerComputerCatalog(registry);
  const listed = (ids: string[]) => ({
    isReady: true,
    entries: new Map(ids.map((id) => [id, { enabled: true }])),
  });
  registry.set(catalog.atom!, listed(["env"]));
  // Removed after the roster rendered its answer but before that render's effects ran: layout
  // effects run first, so this lands exactly in that gap.
  function RemoveAfterRender() {
    useLayoutEffect(() => {
      registry.set(catalog.atom!, listed([]));
    }, []);
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root?.render(
      <RegistryContext value={registry}>
        <Probe />
        <RemoveAfterRender />
      </RegistryContext>,
    ),
  );
  state.connected = false;
  registry.set(catalog.atom!, listed(["env"]));
  await act(async () =>
    root?.render(
      <RegistryContext value={registry}>
        <Probe />
      </RegistryContext>,
    ),
  );
  expect(memberNames()).toEqual([]);
  stopFollowing();
});

it("an answer from before its computer was removed and added again is not kept", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = echoBots;
  state.botRef = { environmentId: "env", threadId: "bot" };
  const registry = AtomRegistry.make();
  // The app installs this with its registry; the test's own registry needs it too.
  const stopFollowing = followKeptPerComputerCatalog(registry);
  const listed = (ids: string[]) => ({
    isReady: true,
    entries: new Map(ids.map((id) => [id, { enabled: true }])),
  });
  registry.set(catalog.atom!, listed(["env"]));
  // Removed and added again after the roster rendered its answer, before that render's effects ran.
  function RemoveAndReAddAfterRender() {
    useLayoutEffect(() => {
      registry.set(catalog.atom!, listed([]));
      registry.set(catalog.atom!, listed(["env"]));
    }, []);
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root?.render(
      <RegistryContext value={registry}>
        <Probe />
        <RemoveAndReAddAfterRender />
      </RegistryContext>,
    ),
  );
  state.connected = false;
  await act(async () =>
    root?.render(
      <RegistryContext value={registry}>
        <Probe />
      </RegistryContext>,
    ),
  );
  expect(memberNames()).toEqual([]);
  stopFollowing();
});

it("a refused bot list lists no bots in the same render it arrives", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = echoBots;
  state.botRef = { environmentId: "env", threadId: "bot" };
  const commits: Array<{ members: string[] }> = [];
  function Committed() {
    const roster = useMobileBotRoster();
    const seen = { members: memberNamesOf(roster.bots) };
    useLayoutEffect(() => {
      commits.push(seen);
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Committed />));
  expect(commits.at(-1)).toEqual({ members: ["Echo"] });
  const before = commits.length;
  state.cause = { _tag: "EnvironmentAuthorizationError", message: "Not allowed." };
  await act(async () => root?.render(<Committed />));
  // The first commit after the refused answer already says so.
  expect(commits[before]).toEqual({ members: [] });
});

it("says nothing of Slack once the bot list is refused", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true, slackChannel: true };
  state.slack = [{ enabled: true }];
  state.bots = echoBots;
  state.botRef = { environmentId: "env", threadId: "bot" };
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Probe />));
  expect(value.slackEnabled).toBe(true);
  state.cause = { _tag: "EnvironmentAuthorizationError", message: "Not allowed." };
  await act(async () => root?.render(<Probe />));
  expect(value.slackEnabled).toBe(false);
});
